import test from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection, type Db } from "mongodb";
import sinon from "sinon";
import { BeliefsReader } from "./beliefsReader.js";
import { ContextBuilder, type PersonaLookup } from "./contextBuilder.js";
import type { Belief, BeliefType } from "../types/belief.js";
import type { PersonaCache, PersonaDoc } from "./personaCache.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let col: Collection<Belief>;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  col = db.collection<Belief>("beliefs");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await col.deleteMany({});
});

const NULL_PERSONA: PersonaLookup = {
  get: async () => null,
};

let idSeq = 0;
function makeBelief(overrides: Partial<Belief> = {}): Belief {
  idSeq++;
  const now = new Date();
  return {
    _id: `belief-${idSeq}`,
    user_id: "user-1",
    type: "entity" as BeliefType,
    canonical_name: `fact-${idSeq}`,
    aliases: [],
    content: `Content for belief ${idSeq}`,
    why_it_matters: "It matters",
    scope: ["global"],
    provenance: {
      session_id: "seed",
      turn_id: "seed-turn",
      extracted_at: now,
      source_model: "test",
    },
    epistemic_status: "active",
    confidence: 0.8,
    reinforcement_count: 0,
    last_reinforced_at: now,
    pinned: false,
    user_edited: false,
    resolved_at: null,
    superseded_by: null,
    created_at: now,
    updated_at: now,
    change_log: [],
    ...overrides,
  } as Belief;
}

test.serial("listAlwaysOn returns pinned beliefs", async (t) => {
  const reader = new BeliefsReader(col);
  await col.insertMany([
    makeBelief({ pinned: true, type: "entity" }),
    makeBelief({ pinned: false, type: "entity" }),
  ]);
  const results = await reader.listAlwaysOn("user-1");
  t.is(results.filter((b) => b.pinned).length, 1);
});

test.serial("listAlwaysOn excludes resolved beliefs", async (t) => {
  const reader = new BeliefsReader(col);
  await col.insertMany([
    makeBelief({ pinned: true, resolved_at: new Date() }),
    makeBelief({ pinned: true }),
  ]);
  const results = await reader.listAlwaysOn("user-1");
  t.is(results.length, 1);
  t.is(results[0].resolved_at, null);
});

test.serial("listAlwaysOn excludes superseded beliefs", async (t) => {
  const reader = new BeliefsReader(col);
  await col.insertMany([
    makeBelief({ pinned: true, superseded_by: "other-belief-id" }),
    makeBelief({ pinned: true }),
  ]);
  const results = await reader.listAlwaysOn("user-1");
  t.is(results.length, 1);
});

test.serial("listAlwaysOn is scoped to userId", async (t) => {
  const reader = new BeliefsReader(col);
  await col.insertMany([
    makeBelief({ user_id: "user-1", pinned: true }),
    makeBelief({ user_id: "user-2", pinned: true }),
  ]);
  const results = await reader.listAlwaysOn("user-1");
  t.true(results.every((b) => b.user_id === "user-1"));
});

test.serial(
  "listByScope returns beliefs matching any scope in array",
  async (t) => {
    const reader = new BeliefsReader(col);
    await col.insertMany([
      makeBelief({ scope: ["work"] }),
      makeBelief({ scope: ["personal"] }),
      makeBelief({ scope: ["other"] }),
    ]);
    const results = await reader.listByScope("user-1", ["work", "personal"]);
    t.is(results.length, 2);
  },
);

test.serial("listByScope respects type filter", async (t) => {
  const reader = new BeliefsReader(col);
  await col.insertMany([
    makeBelief({ scope: ["work"], type: "entity" }),
    makeBelief({ scope: ["work"], type: "preference" }),
  ]);
  const results = await reader.listByScope("user-1", ["work"], ["entity"]);
  t.true(results.every((b) => b.type === "entity"));
});

test.serial("listByScope respects limit", async (t) => {
  const reader = new BeliefsReader(col);
  const beliefs = Array.from({ length: 10 }, () =>
    makeBelief({ scope: ["work"] }),
  );
  await col.insertMany(beliefs);
  const results = await reader.listByScope("user-1", ["work"], undefined, 3);
  t.is(results.length, 3);
});

test.serial("listByScope excludes inactive beliefs", async (t) => {
  const reader = new BeliefsReader(col);
  await col.insertMany([
    makeBelief({ scope: ["work"], resolved_at: new Date() }),
    makeBelief({ scope: ["work"] }),
  ]);
  const results = await reader.listByScope("user-1", ["work"]);
  t.is(results.length, 1);
});

test.serial(
  "listPinnedOpenQuestions returns pinned open questions only",
  async (t) => {
    const reader = new BeliefsReader(col);
    await col.insertMany([
      makeBelief({ type: "open_question", pinned: true }),
      makeBelief({ type: "open_question", pinned: false }),
      makeBelief({ type: "entity", pinned: true }),
    ]);
    const results = await reader.listPinnedOpenQuestions("user-1");
    t.is(results.length, 1);
    t.is(results[0].type, "open_question");
    t.true(results[0].pinned);
  },
);

test.serial("listPinnedOpenQuestions respects limit", async (t) => {
  const reader = new BeliefsReader(col);
  const beliefs = Array.from({ length: 20 }, () =>
    makeBelief({ type: "open_question", pinned: true }),
  );
  await col.insertMany(beliefs);
  const results = await reader.listPinnedOpenQuestions("user-1", undefined, 5);
  t.is(results.length, 5);
});

function makeReader(
  pinnedFacts: Belief[],
  relevant: Belief[],
  questions: Belief[],
): BeliefsReader {
  const stub = {
    listPinnedFacts: sinon.stub().resolves(pinnedFacts),
    searchText: sinon.stub().resolves(relevant),
    listPinnedOpenQuestions: sinon.stub().resolves(questions),
    listAlwaysOn: sinon.stub().resolves([]),
    listByScope: sinon.stub().resolves([]),
  };
  return stub as unknown as BeliefsReader;
}

function makePersonaStub(
  universal = "You prefer direct answers.",
  per_scope: Record<string, string> = {},
): PersonaCache {
  const doc: PersonaDoc = {
    _id: "user-1",
    universal,
    per_scope,
    contributing_belief_ids: [],
    beliefs_hash: "x",
    generated_at: new Date(),
    model: "test",
  };
  return { get: sinon.stub().resolves(doc) } as unknown as PersonaCache;
}

test.serial("ContextBuilder.build returns valid JSON strings", async (t) => {
  const belief = makeBelief();
  const reader = makeReader([belief], [], []);
  const builder = new ContextBuilder(reader, makePersonaStub());
  const ctx = await builder.build("user-1", ["global"], "");
  t.notThrows(() => JSON.parse(ctx.relevantBeliefsJson));
  t.notThrows(() => JSON.parse(ctx.pinnedFactsJson));
  t.notThrows(() => JSON.parse(ctx.openQuestionsJson));
});

test.serial(
  "ContextBuilder.build deduplicates pinnedFacts and relevant",
  async (t) => {
    const shared = makeBelief({ pinned: true, type: "decision" });
    const reader = makeReader([shared], [shared], []);
    const builder = new ContextBuilder(reader, makePersonaStub());
    const ctx = await builder.build("user-1", ["global"], "test");
    const pinned = JSON.parse(ctx.pinnedFactsJson);
    const relevant = JSON.parse(ctx.relevantBeliefsJson);
    t.is(pinned.length, 1);
    t.is(relevant.length, 0);
  },
);

test.serial("ContextBuilder.build reports correct beliefCount", async (t) => {
  const beliefs = [makeBelief(), makeBelief()];
  const reader = makeReader(beliefs, [], []);
  const builder = new ContextBuilder(reader, makePersonaStub());
  const ctx = await builder.build("user-1", [], "");
  t.is(ctx.beliefCount, 2);
});

test.serial("ContextBuilder.build reports correct questionCount", async (t) => {
  const questions = [
    makeBelief({ type: "open_question", pinned: true }),
    makeBelief({ type: "open_question", pinned: true }),
  ];
  const reader = makeReader([], [], questions);
  const builder = new ContextBuilder(reader, makePersonaStub());
  const ctx = await builder.build("user-1", [], "");
  t.is(ctx.questionCount, 2);
});

test.serial(
  "ContextBuilder.build truncates content beyond maxCharsPerBelief",
  async (t) => {
    const longContent = "x".repeat(500);
    const belief = makeBelief({ content: longContent });
    const reader = makeReader([], [belief], []);
    const builder = new ContextBuilder(reader, makePersonaStub(), {
      maxCharsPerBelief: 400,
    });
    const ctx = await builder.build("user-1", [], "anything matches");
    const beliefs = JSON.parse(ctx.relevantBeliefsJson);
    t.true(beliefs[0].content.length <= 400);
  },
);

test.serial(
  "ContextBuilder.build sets truncated=true when maxBeliefs is exceeded",
  async (t) => {
    const many = Array.from({ length: 5 }, () => makeBelief());
    const reader = makeReader(many, [], []);
    const builder = new ContextBuilder(reader, NULL_PERSONA, { maxBeliefs: 3 });
    const ctx = await builder.build("user-1", [], "");
    t.true(ctx.truncated);
    t.is(ctx.beliefCount, 3);
  },
);

test.serial(
  "ContextBuilder.build sets truncated=false when under budget",
  async (t) => {
    const reader = makeReader([makeBelief()], [], []);
    const builder = new ContextBuilder(reader, makePersonaStub());
    const ctx = await builder.build("user-1", [], "");
    t.false(ctx.truncated);
  },
);

test.serial(
  "ContextBuilder.build projects expected fields into JSON",
  async (t) => {
    const belief = makeBelief({
      _id: "b-proj",
      canonical_name: "my-fact",
      aliases: ["alias1"],
      why_it_matters: "matters a lot",
      epistemic_status: "active",
      confidence: 0.64,
      pinned: true,
      type: "decision",
    });
    const reader = makeReader([belief], [], []);
    const builder = new ContextBuilder(reader, makePersonaStub());
    const ctx = await builder.build("user-1", [], "");
    const pinned = JSON.parse(ctx.pinnedFactsJson);
    const projected = pinned[0];
    t.is(projected.id, "b-proj");
    t.is(projected.canonical_name, "my-fact");
    t.is(projected.why_it_matters, "matters a lot");
    t.is(projected.confidence, 0.64);
  },
);

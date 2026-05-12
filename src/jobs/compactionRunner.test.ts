import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection, type Db } from "mongodb";
import sinon from "sinon";
import { BeliefCompactionRunner } from "./compactionRunner.js";
import type { Belief } from "../types/belief.js";
import type { CompactionLogEntry } from "./compactionRunner.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { PersonaCache } from "../context/personaCache.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let beliefs: Collection<Belief>;
let compactionLog: Collection<CompactionLogEntry>;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  beliefs = db.collection<Belief>("beliefs");
  compactionLog = db.collection<CompactionLogEntry>("compaction_log");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await beliefs.deleteMany({});
  await compactionLog.deleteMany({});
});

let beliefCounter = 0;

function makeBelief(overrides: Partial<Belief> = {}): Belief {
  const id = `belief-${++beliefCounter}`;
  const now = new Date();
  return {
    _id: id,
    user_id: "user-1",
    type: "preference",
    subtype: null,
    canonical_name: `belief_${id}`,
    aliases: [],
    content: `Content for ${id}`,
    why_it_matters: `Matters because of ${id}`,
    scope: ["user:universal"],
    provenance: {
      session_id: "sess-1",
      turn_id: "turn-1",
      extracted_at: now,
      source_model: "test-model",
    },
    epistemic_status: "active",
    confidence: 0.8,
    reinforcement_count: 0,
    last_reinforced_at: now,
    pinned: false,
    user_edited: false,
    superseded_by: null,
    resolved_at: null,
    change_log: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeExpertiseBelief(
  domain: string,
  overrides: Partial<Belief> = {},
): Belief {
  return makeBelief({
    subtype: "expertise",
    canonical_name: `${domain.replace("/", "_")}_expertise`,
    expertise_domain: domain,
    expertise_depth: "working",
    content: `Works with ${domain} at a working level`,
    why_it_matters: `Skip basics for ${domain}`,
    ...overrides,
  });
}

async function insertBeliefs(docs: Belief[]): Promise<void> {
  if (docs.length > 0) await beliefs.insertMany(docs);
}

function makeAdapter(response: object): ProviderAdapter {
  return {
    id: "test",
    call: sinon.stub().resolves({
      content: JSON.stringify(response),
      model: "test-model",
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
    callStream: undefined,
    listModels: undefined,
  } as unknown as ProviderAdapter;
}

function makePersonaCache(overrides: Partial<PersonaCache> = {}): PersonaCache {
  return {
    get: sinon.stub().resolves(null),
    put: sinon.stub().resolves(),
    invalidate: sinon.stub().resolves(),
    regenerate: sinon.stub().resolves(),
    ...overrides,
  } as unknown as PersonaCache;
}

function makePersonaSummary() {
  return { regenerate: sinon.stub().resolves() };
}

function makeRunner(
  adapter: ProviderAdapter,
  personaCache?: PersonaCache,
  personaSummary?: ReturnType<typeof makePersonaSummary>,
  cooldownMs = 0,
) {
  return new BeliefCompactionRunner(
    beliefs,
    compactionLog,
    () => adapter,
    "test-model",
    personaCache ?? makePersonaCache(),
    personaSummary ?? makePersonaSummary(),
    { cooldownMs },
  );
}

test("run does nothing when belief count is below threshold", async (t) => {
  const docs = Array.from({ length: 14 }, () => makeBelief());
  await insertBeliefs(docs);

  const adapter = makeAdapter({ merges: [], no_action_ids: [] });
  const runner = makeRunner(adapter);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 0);
  t.is(await compactionLog.countDocuments(), 0);
});

test("run triggers compaction when preference count meets threshold", async (t) => {
  const docs = Array.from({ length: 15 }, () => makeBelief());
  await insertBeliefs(docs);

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });
  const runner = makeRunner(adapter);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 1);
  t.is(await compactionLog.countDocuments(), 1);
});

test("run respects cooldown and skips recently compacted scope", async (t) => {
  const docs = Array.from({ length: 15 }, () => makeBelief());
  await insertBeliefs(docs);

  await compactionLog.insertOne({
    _id: "log-1",
    user_id: "user-1",
    scope: "user:universal",
    belief_type: "preference",
    ran_at: new Date(),
    merged_count: 0,
  });

  const adapter = makeAdapter({ merges: [], no_action_ids: [] });

  const runner = makeRunner(adapter, undefined, undefined, 60 * 60 * 1000);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 0);
});

test("run processes scope after cooldown has expired", async (t) => {
  const docs = Array.from({ length: 15 }, () => makeBelief());
  await insertBeliefs(docs);

  await compactionLog.insertOne({
    _id: "log-old",
    user_id: "user-1",
    scope: "user:universal",
    belief_type: "preference",
    ran_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
    merged_count: 0,
  });

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });

  const runner = makeRunner(adapter, undefined, undefined, 60 * 60 * 1000);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 1);
});

test("run only processes beliefs for the specified user", async (t) => {
  const user1Beliefs = Array.from({ length: 15 }, () =>
    makeBelief({ user_id: "user-1" }),
  );
  const user2Beliefs = Array.from({ length: 15 }, () =>
    makeBelief({ user_id: "user-2" }),
  );
  await insertBeliefs([...user1Beliefs, ...user2Beliefs]);

  const ids = user1Beliefs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });
  const runner = makeRunner(adapter);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 1);
});

test("run handles multiple qualifying scopes independently", async (t) => {
  const universal = Array.from({ length: 15 }, () =>
    makeBelief({ scope: ["user:universal"] }),
  );
  const projectScoped = Array.from({ length: 15 }, () =>
    makeBelief({ scope: ["project:my-app"] }),
  );
  await insertBeliefs([...universal, ...projectScoped]);

  const adapter = makeAdapter({ merges: [], no_action_ids: [] });
  const runner = makeRunner(adapter);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 2);
  t.is(await compactionLog.countDocuments(), 2);
});

test("applyDedupMerges inserts a new merged belief", async (t) => {
  const b1 = makeBelief({ canonical_name: "prefers_brevity" });
  const b2 = makeBelief({ canonical_name: "likes_short_responses" });

  const fillers = Array.from({ length: 13 }, () => makeBelief());
  await insertBeliefs([b1, b2, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: "Strongly prefers brief responses",
        merged_canonical_name: "prefers_brevity",
        merged_aliases: ["likes_short_responses", b2._id],
        compaction_note: "Two beliefs about response length merged",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const src1 = await beliefs.findOne({ _id: b1._id });
  const src2 = await beliefs.findOne({ _id: b2._id });
  t.is(src1!.epistemic_status, "superseded");
  t.is(src2!.epistemic_status, "superseded");
  t.truthy(src1!.superseded_by);
  t.is(src1!.superseded_by, src2!.superseded_by);
});

test("merged belief has correct content and canonical name", async (t) => {
  const b1 = makeBelief({ canonical_name: "uses_typescript" });
  const b2 = makeBelief({ canonical_name: "prefers_typescript" });
  const fillers = Array.from({ length: 13 }, () => makeBelief());
  await insertBeliefs([b1, b2, ...fillers]);

  const mergedCanonical = "typescript_preference";
  const mergedContent = "Uses TypeScript exclusively; no plain JS";

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: mergedContent,
        merged_canonical_name: mergedCanonical,
        merged_aliases: ["uses_typescript", "prefers_typescript"],
        compaction_note: "Merged two TypeScript preference beliefs",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const merged = await beliefs.findOne({
    canonical_name: mergedCanonical,
    superseded_by: null,
  });
  t.truthy(merged);
  t.is(merged!.content, mergedContent);
  t.deepEqual(merged!.aliases, ["uses_typescript", "prefers_typescript"]);
});

test("merged belief accumulates reinforcement_count from all sources", async (t) => {
  const b1 = makeBelief({ reinforcement_count: 3 });
  const b2 = makeBelief({ reinforcement_count: 5 });
  const fillers = Array.from({ length: 13 }, () => makeBelief());
  await insertBeliefs([b1, b2, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: "Merged content",
        merged_canonical_name: "merged_belief",
        merged_aliases: [],
        compaction_note: "Merged",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const merged = await beliefs.findOne({
    canonical_name: "merged_belief",
    superseded_by: null,
  });
  t.is(merged!.reinforcement_count, 8);
});

test("merged belief is promoted to active when all sources are inferred and combined count meets threshold", async (t) => {
  const b1 = makeBelief({
    epistemic_status: "inferred",
    reinforcement_count: 2,
  });
  const b2 = makeBelief({
    epistemic_status: "inferred",
    reinforcement_count: 2,
  });
  const fillers = Array.from({ length: 13 }, () => makeBelief());
  await insertBeliefs([b1, b2, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: "Merged inferred belief",
        merged_canonical_name: "promoted_belief",
        merged_aliases: [],
        compaction_note: "Promoted from inferred",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const merged = await beliefs.findOne({
    canonical_name: "promoted_belief",
    superseded_by: null,
  });
  t.is(merged!.epistemic_status, "active");
});

test("merged belief stays inferred when combined count is below promotion threshold", async (t) => {
  const b1 = makeBelief({
    epistemic_status: "inferred",
    reinforcement_count: 1,
  });
  const b2 = makeBelief({
    epistemic_status: "inferred",
    reinforcement_count: 1,
  });
  const fillers = Array.from({ length: 13 }, () => makeBelief());
  await insertBeliefs([b1, b2, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: "Still inferred",
        merged_canonical_name: "still_inferred",
        merged_aliases: [],
        compaction_note: "Not promoted",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const merged = await beliefs.findOne({
    canonical_name: "still_inferred",
    superseded_by: null,
  });
  t.is(merged!.epistemic_status, "inferred");
});

test("merged belief keeps source epistemic_status when not all sources are inferred", async (t) => {
  const b1 = makeBelief({ epistemic_status: "active", reinforcement_count: 5 });
  const b2 = makeBelief({
    epistemic_status: "inferred",
    reinforcement_count: 5,
  });
  const fillers = Array.from({ length: 13 }, () => makeBelief());
  await insertBeliefs([b1, b2, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: "Mixed sources",
        merged_canonical_name: "mixed_merge",
        merged_aliases: [],
        compaction_note: "Mixed",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const merged = await beliefs.findOne({
    canonical_name: "mixed_merge",
    superseded_by: null,
  });

  t.is(merged!.epistemic_status, "active");
});

test("compaction is skipped when LLM returns no merges", async (t) => {
  const docs = Array.from({ length: 15 }, () => makeBelief());
  await insertBeliefs(docs);

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  t.is(await compactionLog.countDocuments(), 1);
  const superseded = await beliefs.countDocuments({
    epistemic_status: "superseded",
  });
  t.is(superseded, 0);
});

test("merge is skipped silently when keep_id is not found", async (t) => {
  const b1 = makeBelief();
  const fillers = Array.from({ length: 14 }, () => makeBelief());
  await insertBeliefs([b1, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: "nonexistent-id",
        retire_ids: [b1._id],
        merged_content: "Should not appear",
        merged_canonical_name: "ghost_merge",
        merged_aliases: [],
        compaction_note: "Ghost",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);

  await t.notThrowsAsync(() => runner.run("user-1"));

  const ghost = await beliefs.findOne({ canonical_name: "ghost_merge" });
  t.is(ghost, null);
});

test("preference compaction invalidates the persona cache", async (t) => {
  const docs = Array.from({ length: 15 }, () => makeBelief());
  await insertBeliefs(docs);

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });
  const personaCache = makePersonaCache();
  const runner = makeRunner(adapter, personaCache);
  await runner.run("user-1");

  t.is((personaCache.invalidate as sinon.SinonStub).callCount, 1);
});

test("entity compaction does not invalidate the persona cache", async (t) => {
  const docs = Array.from({ length: 25 }, () => makeBelief({ type: "entity" }));
  await insertBeliefs(docs);

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });
  const personaCache = makePersonaCache();
  const runner = makeRunner(adapter, personaCache);
  await runner.run("user-1");

  t.is((personaCache.invalidate as sinon.SinonStub).callCount, 0);
});

test("decision compaction does not invalidate the persona cache", async (t) => {
  const docs = Array.from({ length: 20 }, () =>
    makeBelief({ type: "decision" }),
  );
  await insertBeliefs(docs);

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });
  const personaCache = makePersonaCache();
  const runner = makeRunner(adapter, personaCache);
  await runner.run("user-1");

  t.is((personaCache.invalidate as sinon.SinonStub).callCount, 0);
});

test("compaction log entry records correct fields", async (t) => {
  const docs = Array.from({ length: 15 }, () => makeBelief());
  await insertBeliefs(docs);

  const ids = docs.map((d) => d._id);
  const adapter = makeAdapter({ merges: [], no_action_ids: ids });
  const runner = makeRunner(adapter);

  const before = new Date();
  await runner.run("user-1");
  const after = new Date();

  const entry = await compactionLog.findOne({ user_id: "user-1" });
  t.truthy(entry);
  t.is(entry!.user_id, "user-1");
  t.is(entry!.scope, "user:universal");
  t.is(entry!.belief_type, "preference");
  t.is(entry!.merged_count, 0);
  t.true(entry!.ran_at >= before);
  t.true(entry!.ran_at <= after);
});

test("merged_count in log reflects actual merges performed", async (t) => {
  const b1 = makeBelief();
  const b2 = makeBelief();
  const b3 = makeBelief();
  const b4 = makeBelief();
  const fillers = Array.from({ length: 11 }, () => makeBelief());
  await insertBeliefs([b1, b2, b3, b4, ...fillers]);

  const adapter = makeAdapter({
    merges: [
      {
        keep_id: b1._id,
        retire_ids: [b2._id],
        merged_content: "Merge 1",
        merged_canonical_name: "merge_one",
        merged_aliases: [],
        compaction_note: "First merge",
        belief_type: "preference",
      },
      {
        keep_id: b3._id,
        retire_ids: [b4._id],
        merged_content: "Merge 2",
        merged_canonical_name: "merge_two",
        merged_aliases: [],
        compaction_note: "Second merge",
        belief_type: "preference",
      },
    ],
    no_action_ids: fillers.map((f) => f._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const entry = await compactionLog.findOne({ user_id: "user-1" });
  t.is(entry!.merged_count, 2);
});

test("expertise compaction triggers when expertise belief count meets threshold", async (t) => {
  const docs = Array.from({ length: 8 }, (_, i) =>
    makeExpertiseBelief(`javascript/topic-${i}`),
  );
  await insertBeliefs(docs);

  const adapter = makeAdapter({
    assessments: [
      {
        domain: "javascript",
        depth: "working",
        evidence_count: 8,
        canonical_name: "javascript_expertise",
        content: "Works with JavaScript at a working level",
        why_it_matters: "Skip JS basics",
        scope: ["user:universal"],
        confidence: 0.85,
      },
    ],
    retire_ids: docs.map((d) => d._id),
  });

  const personaSummary = makePersonaSummary();
  const runner = makeRunner(adapter, undefined, personaSummary);
  await runner.run("user-1");

  t.is((adapter.call as sinon.SinonStub).callCount, 1);
  const synthesized = await beliefs.findOne({
    canonical_name: "javascript_expertise",
    superseded_by: null,
  });
  t.truthy(synthesized);
  t.is(synthesized!.subtype, "expertise");
  t.is(synthesized!.expertise_domain, "javascript");
  t.is(synthesized!.expertise_depth, "working");
  t.is(synthesized!.expertise_evidence_count, 8);
});

test("expertise synthesis retires source beliefs", async (t) => {
  const docs = Array.from({ length: 8 }, (_, i) =>
    makeExpertiseBelief(`python/topic-${i}`),
  );
  await insertBeliefs(docs);

  const retireIds = docs.map((d) => d._id);
  const adapter = makeAdapter({
    assessments: [
      {
        domain: "python",
        depth: "deep",
        evidence_count: 8,
        canonical_name: "python_expertise",
        content: "Deep Python knowledge",
        why_it_matters: "Treat as peer",
        scope: ["user:universal"],
        confidence: 0.9,
      },
    ],
    retire_ids: retireIds,
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  for (const id of retireIds) {
    const b = await beliefs.findOne({ _id: id });
    t.is(b!.epistemic_status, "superseded");
    t.truthy(b!.superseded_by);
  }
});

test("expertise synthesis supersedes existing assessment for same domain", async (t) => {
  const existingAssessment = makeExpertiseBelief("rust", {
    _id: "existing-rust-expertise",
    canonical_name: "rust_expertise",
    epistemic_status: "active",
    superseded_by: null,
  });

  const sources = Array.from({ length: 8 }, () => makeExpertiseBelief("rust"));
  await insertBeliefs([existingAssessment, ...sources]);

  const adapter = makeAdapter({
    assessments: [
      {
        domain: "rust",
        depth: "expert",
        evidence_count: 8,
        canonical_name: "rust_expertise",
        content: "Expert-level Rust",
        why_it_matters: "Defer on Rust opinions",
        scope: ["user:universal"],
        confidence: 0.95,
      },
    ],
    retire_ids: sources.map((d) => d._id),
  });

  const runner = makeRunner(adapter);
  await runner.run("user-1");

  const old = await beliefs.findOne({ _id: existingAssessment._id });
  t.is(old!.epistemic_status, "superseded");

  const active = await beliefs.findOne({
    canonical_name: "rust_expertise",
    superseded_by: null,
  });
  t.truthy(active);
  t.is(active!.expertise_depth, "expert");
  t.not(active!._id, existingAssessment._id);
});

test("expertise synthesis calls personaSummary.regenerate", async (t) => {
  const docs = Array.from({ length: 8 }, (_, i) =>
    makeExpertiseBelief(`go/topic-${i}`),
  );
  await insertBeliefs(docs);

  const adapter = makeAdapter({
    assessments: [
      {
        domain: "go",
        depth: "working",
        evidence_count: 8,
        canonical_name: "go_expertise",
        content: "Working-level Go",
        why_it_matters: "Skip Go basics",
        scope: ["user:universal"],
        confidence: 0.8,
      },
    ],
    retire_ids: docs.map((d) => d._id),
  });

  const personaSummary = makePersonaSummary();
  const runner = makeRunner(adapter, undefined, personaSummary);
  await runner.run("user-1");

  t.is((personaSummary.regenerate as sinon.SinonStub).callCount, 1);
  t.is(
    (personaSummary.regenerate as sinon.SinonStub).firstCall.args[0],
    "user-1",
  );
});

test("expertise synthesis does nothing when LLM returns no assessments", async (t) => {
  const docs = Array.from({ length: 8 }, (_, i) =>
    makeExpertiseBelief(`scala/topic-${i}`),
  );
  await insertBeliefs(docs);

  const adapter = makeAdapter({ assessments: [], retire_ids: [] });
  const personaSummary = makePersonaSummary();
  const runner = makeRunner(adapter, undefined, personaSummary);
  await runner.run("user-1");

  t.is(await compactionLog.countDocuments(), 1);

  const superseded = await beliefs.countDocuments({
    epistemic_status: "superseded",
  });
  t.is(superseded, 0);

  t.is((personaSummary.regenerate as sinon.SinonStub).callCount, 0);
});

test("run continues processing other scopes when one scope compaction fails", async (t) => {
  const universal = Array.from({ length: 15 }, () =>
    makeBelief({ scope: ["user:universal"] }),
  );
  const projectScoped = Array.from({ length: 15 }, () =>
    makeBelief({ scope: ["project:my-app"] }),
  );
  await insertBeliefs([...universal, ...projectScoped]);

  let callCount = 0;
  const faultyAdapter: ProviderAdapter = {
    id: "test",
    call: sinon.stub().callsFake(async () => {
      callCount++;
      if (callCount === 1) throw new Error("LLM exploded");
      return {
        content: JSON.stringify({ merges: [], no_action_ids: [] }),
        model: "test-model",
        finish_reason: "stop",
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    }),
    callStream: undefined,
    listModels: undefined,
  } as unknown as ProviderAdapter;

  const runner = makeRunner(faultyAdapter);
  await t.notThrowsAsync(() => runner.run("user-1"));

  t.is(callCount, 2);
});

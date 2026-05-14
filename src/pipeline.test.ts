import anyTest, { type TestFn } from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db, type Document } from "mongodb";
import { randomUUID } from "node:crypto";
import sinon from "sinon";

import { registerChatRoute, type ChatDeps } from "./routes/chat.js";
import { SessionManager } from "./session/manager.js";
import { HistoryManager } from "./history/manager.js";
import { BeliefsReader } from "./context/beliefsReader.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { estimateTurnTokens } from "./history/compaction.js";
import { SIDECAR_BEGIN, SIDECAR_END } from "./sidecar/splitter.js";
import type { Belief } from "./types/belief.js";
import type { Turn } from "./history/manager.js";
import {
  flattenSystemPrompt,
  type NormalizedResponse,
  type ProviderAdapter,
} from "./providers/types.js";
import { SCENARIOS } from "./__fixtures__/conversations.js";
import type { PersonaCache } from "./context/personaCache.js";
import { RuntimeConfigStore } from "./config/runtime.js";
import { ErrorLogger } from "./errors/logger.js";

const test = anyTest.serial as TestFn;

const USER_ID = "pipeline-user";
const SESSION_PREFIX = "pipe";
const PROVIDER_ID = "anthropic";
const MODEL = "claude-haiku-4-5-20251001";

const BELIEF_ID = {
  stackPreference: "seed-belief-stack-pref",
  compositionPreference: "seed-belief-composition",
  databaseQuestion: "seed-belief-db-question",
  commitmentFastify: "seed-belief-commitment-fastify",
} as const;

const NULL_PERSONA = {
  get: async () => null,
  put: async () => {},
  invalidate: async () => {},
  regenerate: async () => {},
  col: null as any,
} as unknown as PersonaCache;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("pipeline");

  await db
    .collection("turns")
    .createIndex(
      { userMessage: "text", assistantMessage: "text" },
      { background: true },
    );

  await db
    .collection("beliefs")
    .createIndex(
      { canonical_name: "text", content: "text", aliases: "text" },
      { background: true },
    );

  await seedBeliefs();
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.afterEach(async () => {
  sinon.restore();
  await Promise.all([
    db.collection("sessions").deleteMany({}),
    db.collection("turns").deleteMany({}),
    db.collection("jobs").deleteMany({}),
  ]);
});

async function seedBeliefs(): Promise<void> {
  const col = db.collection<Belief>("beliefs");
  const now = new Date();
  const prov: Belief["provenance"] = {
    session_id: "seed",
    turn_id: "seed-turn",
    extracted_at: now,
    source_model: "seed",
  };

  const docs: Belief[] = [
    {
      _id: BELIEF_ID.stackPreference,
      user_id: USER_ID,
      type: "preference",
      canonical_name: "project-stack",
      aliases: ["stack", "language"],
      content: "REST API in TypeScript with Fastify",
      why_it_matters: "Core project context, avoids Express suggestions",
      scope: ["coding"],
      provenance: prov,
      epistemic_status: "active",
      confidence: 0.95,
      reinforcement_count: 0,
      last_reinforced_at: now,
      pinned: false,
      user_edited: false,
      resolved_at: null,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      change_log: [],
      subtype: null,
    },
    {
      _id: BELIEF_ID.compositionPreference,
      user_id: USER_ID,
      type: "preference",
      canonical_name: "composition-over-inheritance",
      aliases: [],
      content: "Prefers composition over inheritance",
      why_it_matters:
        "Affects class design suggestions in every coding session",
      scope: ["coding"],
      provenance: prov,
      epistemic_status: "active",
      confidence: 0.9,
      reinforcement_count: 0,
      last_reinforced_at: now,
      pinned: true,
      user_edited: false,
      resolved_at: null,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      change_log: [],
      subtype: null,
    },
    {
      _id: BELIEF_ID.databaseQuestion,
      user_id: USER_ID,
      type: "open_question",
      canonical_name: "database-choice",
      aliases: ["db"],
      content: "PostgreSQL vs MongoDB — decision not yet made",
      why_it_matters: "Unresolved; LLM must not assume a choice",
      scope: ["coding"],
      provenance: prov,
      epistemic_status: "exploratory",
      confidence: 0.5,
      reinforcement_count: 0,
      last_reinforced_at: now,
      pinned: true,
      user_edited: false,
      resolved_at: null,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      change_log: [],
      subtype: null,
    },
    {
      _id: BELIEF_ID.commitmentFastify,
      user_id: USER_ID,
      type: "decision",
      canonical_name: "web-framework",
      aliases: ["framework"],
      content: "Using Fastify — decided, not Express",
      why_it_matters:
        "Prevents wrong-framework suggestions across all sessions",
      scope: ["coding"],
      provenance: prov,
      epistemic_status: "active",
      confidence: 1.0,
      reinforcement_count: 0,
      last_reinforced_at: now,
      pinned: true,
      user_edited: false,
      resolved_at: null,
      superseded_by: null,
      created_at: now,
      updated_at: now,
      change_log: [],
      subtype: null,
    },
  ];

  await Promise.all(
    docs.map((doc) => col.replaceOne({ _id: doc._id }, doc, { upsert: true })),
  );
}

async function waitForJobs(
  sessionId: string,
  count: number,
  timeoutMs = 3000,
): Promise<Document[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const jobs = await db
      .collection("jobs")
      .find({ session_id: sessionId })
      .sort({ created_at: 1 })
      .toArray();
    if (jobs.length >= count) return jobs;
    await new Promise((r) => setTimeout(r, 25));
  }
  return db
    .collection("jobs")
    .find({ session_id: sessionId })
    .sort({ created_at: 1 })
    .toArray();
}

async function waitForTurns(
  sessionId: string,
  count: number,
  timeoutMs = 3000,
): Promise<Document[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const turns = await db
      .collection("turns")
      .find({ sessionId })
      .sort({ turnIndex: 1 })
      .toArray();
    if (turns.length >= count) return turns;
    await new Promise((r) => setTimeout(r, 25));
  }
  return db
    .collection("turns")
    .find({ sessionId })
    .sort({ turnIndex: 1 })
    .toArray();
}

interface SeededTurnSpec {
  userMessage: string;
  assistantMessage: string;
  turnSignal: Turn["turnSignal"];
  hasNewBeliefs?: boolean;
  hasOpenQuestion?: boolean;
  hasCodeBlock?: boolean;
  beliefCandidateIds?: string[];
  topicId?: string;
}

/**
 * Insert synthetic turns directly into the turns collection for a given
 * session. Use when testing compaction logic without HTTP round-trips.
 * afterEach clears the turns collection automatically.
 */
async function seedTurns(
  sessionId: string,
  specs: SeededTurnSpec[],
): Promise<Turn[]> {
  const col = db.collection<Turn>("turns");
  const defaultTopicId = randomUUID();

  const docs: Turn[] = specs.map((s, i) => ({
    _id: randomUUID(),
    sessionId,
    userId: USER_ID,
    turnIndex: i,
    userMessage: s.userMessage,
    assistantMessage: s.assistantMessage,
    turnSignal: s.turnSignal,
    hasOpenQuestion: s.hasOpenQuestion ?? false,
    hasNewBeliefs: s.hasNewBeliefs ?? false,
    hasBinaryContent: false,
    hasCodeBlock: s.hasCodeBlock ?? false,
    scope: ["coding"],
    createdAt: new Date(),
    state: "kept",
    topicId: s.topicId ?? defaultTopicId,
    topics: [],
    beliefCandidateIds: s.beliefCandidateIds ?? [],
    userRestored: false,
    tokenEstimate: estimateTurnTokens(s.userMessage, s.assistantMessage),
    collapsedBy: null,
    status: "complete",
    failureReason: null,
  }));

  if (docs.length > 0) await col.insertMany(docs);
  return docs;
}

function buildReplayApp(responseContents: string[]): {
  app: FastifyInstance;
  deps: ChatDeps;
} {
  let idx = 0;
  const adapter: ProviderAdapter = {
    id: PROVIDER_ID,
    call: async (): Promise<NormalizedResponse> => ({
      content: responseContents[idx++],
      model: MODEL,
      provider: PROVIDER_ID,
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 20 },
    }),
  };

  const registry = new ProviderRegistry();
  registry.register(adapter);

  const reader = new BeliefsReader(db.collection("beliefs"));
  sinon.stub(reader, "searchText").resolves([]);

  const extractionWorker = {
    sweep: async () => 0,
    processById: async (_jobId: string) => {},
  };

  const runtimeStore = {
    load: sinon.stub().resolves({ extraction_enabled: true }),
    set: sinon.stub().resolves(),
  };

  const deps: ChatDeps = {
    sessions: new SessionManager(db),
    history: new HistoryManager(db),
    context: new ContextBuilder(reader, NULL_PERSONA),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker,
    runtimeStore: runtimeStore as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  };

  const app = Fastify();
  registerChatRoute(app, deps);
  return { app, deps };
}

async function replay(
  app: FastifyInstance,
  sessionId: string,
  userMessage: string,
  extraMessages: Array<{ role: string; content: string }> = [],
) {
  const messages = [...extraMessages, { role: "user", content: userMessage }];
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-session-id": sessionId,
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });
}

function sc(payload: object): string {
  return `\n${SIDECAR_BEGIN}\n${JSON.stringify(payload)}\n${SIDECAR_END}`;
}

const EMPTY_SC = {
  new_beliefs: [],
  belief_updates: [],
  new_open_questions: [],
};

for (const scenario of SCENARIOS) {
  test(`pipeline [${scenario.id}]: ${scenario.name}`, async (t) => {
    const contents = scenario.turns.map((ft) => ft.providerContent);
    const { app } = buildReplayApp(contents);
    await app.ready();
    const sessionId = `${SESSION_PREFIX}-${scenario.id}`;

    for (const ft of scenario.turns) {
      const res = await replay(app, sessionId, ft.userMessage);
      t.is(res.statusCode, 200, `${ft.label}: status`);

      const body = JSON.parse(res.body);
      t.is(
        body.choices[0].message.content,
        ft.expect.visible,
        `${ft.label}: visible content`,
      );
    }

    const turns = await waitForTurns(
      sessionId,
      scenario.expectAfterAll.turnCount,
    );

    t.is(turns.length, scenario.expectAfterAll.turnCount, "turn count");

    for (let i = 0; i < scenario.turns.length; i++) {
      const ft = scenario.turns[i];
      const dbTurn = turns[i];
      t.is(dbTurn.turnIndex, i, `${ft.label}: turnIndex`);
      t.is(
        dbTurn.turnSignal,
        ft.expect.turnSignal,
        `${ft.label}: turnSignal in DB`,
      );
      t.is(
        dbTurn.hasNewBeliefs,
        ft.expect.hasNewBeliefs,
        `${ft.label}: hasNewBeliefs`,
      );
      t.is(
        dbTurn.hasOpenQuestion,
        ft.expect.hasOpenQuestion,
        `${ft.label}: hasOpenQuestion`,
      );
      if (ft.expect.hasCodeBlock !== undefined) {
        t.is(
          dbTurn.hasCodeBlock,
          ft.expect.hasCodeBlock,
          `${ft.label}: hasCodeBlock`,
        );
      }
    }

    const jobs = await waitForJobs(sessionId, scenario.expectAfterAll.jobCount);

    t.is(jobs.length, scenario.expectAfterAll.jobCount, "job count");

    for (let i = 0; i < scenario.turns.length; i++) {
      t.is(jobs[i].status, "pending", `job ${i}: status is pending`);
    }
  });
}

test("pipeline: multi-message input stores the latest user message", async (t) => {
  const { app } = buildReplayApp(["Response." + sc(EMPTY_SC)]);
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-session-id": "multi-msg",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Follow-up question" },
      ],
    }),
  });

  await waitForTurns("multi-msg", 1);
  const turn = await db.collection("turns").findOne({ sessionId: "multi-msg" });
  t.is(turn!.userMessage, "Follow-up question");
});

test("pipeline: assistant-only input list still succeeds", async (t) => {
  const { app } = buildReplayApp(["Echoed." + sc(EMPTY_SC)]);
  await app.ready();

  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-session-id": "no-user-msg",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "assistant", content: "Prior context" }],
    }),
  });

  t.is(res.statusCode, 200);

  await waitForTurns("no-user-msg", 1);
  const turn = await db
    .collection("turns")
    .findOne({ sessionId: "no-user-msg" });
  t.is(turn!.userMessage, "");
});

test("pipeline: system prompt from client is forwarded to provider", async (t) => {
  const callSpy = sinon.stub().resolves({
    content: "Response." + sc(EMPTY_SC),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  const registry = new ProviderRegistry();
  registry.register({ id: PROVIDER_ID, call: callSpy });

  const extractionWorker = {
    sweep: async () => 0,
    processById: async (_jobId: string) => {},
  };

  const reader = new BeliefsReader(db.collection("beliefs"));
  const app = Fastify();
  registerChatRoute(app, {
    sessions: new SessionManager(db),
    history: new HistoryManager(db),
    context: new ContextBuilder(reader, NULL_PERSONA),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-session-id": "sys-prompt",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: "You are a pirate" },
        { role: "user", content: "Hello" },
      ],
    }),
  });

  t.true(callSpy.calledOnce);
  const [, rawPrompt0] = callSpy.firstCall.args;
  const systemPrompt0 = flattenSystemPrompt(rawPrompt0);
  t.true(
    systemPrompt0.includes("You are a pirate"),
    "client system prompt forwarded",
  );
  t.true(
    systemPrompt0.includes("SIDECAR"),
    "sidecar instructions still injected",
  );
});

test("pipeline: seeded beliefs appear in the system prompt", async (t) => {
  const callSpy = sinon.stub().resolves({
    content: "Response." + sc(EMPTY_SC),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  const registry = new ProviderRegistry();
  registry.register({ id: PROVIDER_ID, call: callSpy });

  const reader = new BeliefsReader(db.collection("beliefs"));
  sinon.stub(reader, "searchText").resolves([]);

  const extractionWorker = {
    sweep: async () => 0,
    processById: async (_jobId: string) => {},
  };

  const app = Fastify();
  registerChatRoute(app, {
    sessions: new SessionManager(db),
    history: new HistoryManager(db),
    context: new ContextBuilder(reader, NULL_PERSONA),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-session-id": "belief-injection",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "What framework should I use?" }],
    }),
  });

  t.true(callSpy.calledOnce);
  const [, rawPrompt1] = callSpy.firstCall.args;
  const systemPrompt1 = flattenSystemPrompt(rawPrompt1);

  t.true(
    systemPrompt1.includes("composition-over-inheritance"),
    "PREFERENCE belief injected",
  );

  t.true(systemPrompt1.includes("web-framework"), "commitment belief injected");
  t.true(systemPrompt1.includes("database-choice"), "open question injected");
});

test("pipeline: sidecar-like markers inside user content do not break parsing", async (t) => {
  const { app } = buildReplayApp([
    "The markers are used internally." + sc(EMPTY_SC),
  ]);
  await app.ready();

  const res = await replay(
    app,
    "marker-in-input",
    `Here is my code:\n${SIDECAR_BEGIN}\n{"fake": true}\n${SIDECAR_END}`,
  );

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.choices[0].message.content, "The markers are used internally.");
});

test("pipeline: unicode and emoji in messages round-trip correctly", async (t) => {
  const visible = "La réponse est 42 \u{1F680}";
  const { app } = buildReplayApp([visible + sc(EMPTY_SC)]);
  await app.ready();

  const res = await replay(
    app,
    "unicode-sess",
    "Quelle est la réponse? \u{1F914}",
  );
  const body = JSON.parse(res.body);
  t.is(body.choices[0].message.content, visible);

  await waitForTurns("unicode-sess", 1);
  const turn = await db
    .collection("turns")
    .findOne({ sessionId: "unicode-sess" });
  t.is(turn!.userMessage, "Quelle est la réponse? \u{1F914}");
  t.is(turn!.assistantMessage, visible);
});

test("compaction: ack turns are collapsed when renderCompacted runs", async (t) => {
  const ackScenario = SCENARIOS.find((s) => s.id === "ack-sequence")!;
  const { app, deps } = buildReplayApp(
    ackScenario.turns.map((ft) => ft.providerContent),
  );
  await app.ready();

  const sessionId = `${SESSION_PREFIX}-compact-ack`;
  for (const ft of ackScenario.turns) {
    await replay(app, sessionId, ft.userMessage);
  }

  await waitForTurns(sessionId, ackScenario.turns.length);
  const rendered = await deps.history.renderCompacted(sessionId, 100_000);

  t.true(rendered.turnsCollapsed >= 2, "at least 2 ack turns collapsed");
  t.true(rendered.turnsKept >= 2, "substantive turns kept");

  const dbTurns = await db
    .collection("turns")
    .find({ sessionId, state: "collapsed" })
    .toArray();

  t.true(dbTurns.length >= 2);
  t.true(
    dbTurns.every((t) => t.collapsedBy === "ack"),
    "collapsed by ack rule",
  );
});

test("compaction: correction turns survive compaction", async (t) => {
  const corrScenario = SCENARIOS.find((s) => s.id === "correction-flow")!;
  const { app, deps } = buildReplayApp(
    corrScenario.turns.map((ft) => ft.providerContent),
  );
  await app.ready();

  const sessionId = `${SESSION_PREFIX}-compact-corr`;
  for (const ft of corrScenario.turns) {
    await replay(app, sessionId, ft.userMessage);
  }

  await waitForTurns(sessionId, corrScenario.turns.length);
  const rendered = await deps.history.renderCompacted(sessionId, 100_000);

  const correctionKept = rendered.messages.some(
    (m) =>
      typeof m.content === "string" &&
      m.content.includes("Fastify, not Express"),
  );
  t.true(
    correctionKept,
    "correction turn content preserved in rendered output",
  );
});

test("compaction: code block turns survive budget pressure", async (t) => {
  const codeScenario = SCENARIOS.find((s) => s.id === "code-in-response")!;
  const padContents = Array.from(
    { length: 8 },
    () => "Filler response." + sc(EMPTY_SC),
  );
  const { app, deps } = buildReplayApp([
    ...codeScenario.turns.map((ft) => ft.providerContent),
    ...padContents,
  ]);
  await app.ready();

  const sessionId = `${SESSION_PREFIX}-compact-code`;
  await replay(app, sessionId, codeScenario.turns[0].userMessage);
  for (let i = 0; i < 8; i++) {
    await replay(app, sessionId, `Filler turn ${i}`);
  }

  const rendered = await deps.history.renderCompacted(sessionId, 50);

  const codePreserved = rendered.messages.some(
    (m) => typeof m.content === "string" && m.content.includes("```typescript"),
  );
  t.true(codePreserved, "code block turn protected from budget pressure");
});

test("compaction: dedup collapses substantive turn whose beliefs are all active non-commitments", async (t) => {
  const sessionId = "compact-dedup-collapses";
  const history = new HistoryManager(db);
  const topicId = "topic-shared";

  await seedTurns(sessionId, [
    {
      userMessage: "I'm building a REST API in TypeScript with Fastify.",
      assistantMessage:
        "Great choice! Fastify offers first-class TypeScript support.",
      turnSignal: "substantive",
      hasNewBeliefs: true,
      beliefCandidateIds: [BELIEF_ID.stackPreference],
      topicId,
    },
    {
      userMessage: "How do I structure my routes?",
      assistantMessage: "Use a plugin-per-domain approach.",
      turnSignal: "substantive",
      topicId,
    },
    {
      userMessage: "How do I add CORS?",
      assistantMessage: "Use @fastify/cors.",
      turnSignal: "substantive",
      topicId,
    },
  ]);

  const rendered = await history.renderCompacted(sessionId, 100_000);

  t.is(rendered.turnsCollapsed, 1, "one turn dedup-collapsed");
  t.is(rendered.turnsKept, 2, "middle and trailing turns kept");

  const collapsed = await db
    .collection("turns")
    .find({ sessionId, state: "collapsed" })
    .toArray();

  t.is(collapsed.length, 1);
  t.is(collapsed[0].collapsedBy, "dedup");
  t.true(
    collapsed[0].beliefCandidateIds.includes(BELIEF_ID.stackPreference),
    "collapsed turn is the one with the belief candidate",
  );
});

test("compaction: dedup does NOT collapse a turn with a COMMITMENT belief candidate", async (t) => {
  const sessionId = "compact-dedup-blocked";
  const history = new HistoryManager(db);
  const topicId = "topic-shared";

  await seedTurns(sessionId, [
    {
      userMessage: "Help me set up the web framework.",
      assistantMessage: "Let's set up Fastify. Run: npm install fastify",
      turnSignal: "substantive",
      hasNewBeliefs: true,
      beliefCandidateIds: [BELIEF_ID.commitmentFastify],
      topicId,
    },
    {
      userMessage: "What about rate limiting?",
      assistantMessage: "Use @fastify/rate-limit.",
      turnSignal: "substantive",
      topicId,
    },
  ]);

  const rendered = await history.renderCompacted(sessionId, 100_000);

  t.is(rendered.turnsCollapsed, 0);
  t.is(rendered.turnsKept, 2);
});

test("compaction: dedup does NOT collapse a turn with an open question", async (t) => {
  const sessionId = "compact-dedup-open-q";
  const history = new HistoryManager(db);
  const topicId = "topic-shared";

  await seedTurns(sessionId, [
    {
      userMessage: "Should I use PostgreSQL or MongoDB?",
      assistantMessage: "It depends on your data model.",
      turnSignal: "substantive",
      hasNewBeliefs: true,
      hasOpenQuestion: true,
      beliefCandidateIds: [BELIEF_ID.stackPreference],
      topicId,
    },
    {
      userMessage: "Ok, what else should I consider?",
      assistantMessage: "Think about query patterns and scaling.",
      turnSignal: "substantive",
      topicId,
    },
  ]);

  const rendered = await history.renderCompacted(sessionId, 100_000);

  t.is(rendered.turnsCollapsed, 0);
  t.is(rendered.turnsKept, 2);
});

test("compaction: completed_topic collapses turns on a non-active topic", async (t) => {
  const sessionId = "compact-completed-topic";
  const history = new HistoryManager(db);

  const oldTopic = "topic-error-handling";
  const newTopic = "topic-rate-limiting";

  await seedTurns(sessionId, [
    {
      userMessage: "Tell me about error handling patterns.",
      assistantMessage: "Several approaches exist in Node.js...",
      turnSignal: "substantive",
      topicId: oldTopic,
    },
    {
      userMessage: "What about async error propagation?",
      assistantMessage: "Use async/await with try-catch at the route level.",
      turnSignal: "substantive",
      topicId: oldTopic,
    },
    {
      userMessage: "got it",
      assistantMessage: "👍",
      turnSignal: "acknowledgment",
      topicId: oldTopic,
    },
    {
      userMessage: "ok",
      assistantMessage: "👍",
      turnSignal: "acknowledgment",
      topicId: oldTopic,
    },
    {
      userMessage: "sure",
      assistantMessage: "👍",
      turnSignal: "acknowledgment",
      topicId: oldTopic,
    },
    {
      userMessage: "thanks",
      assistantMessage: "👍",
      turnSignal: "acknowledgment",
      topicId: oldTopic,
    },
    {
      userMessage: "alright",
      assistantMessage: "👍",
      turnSignal: "acknowledgment",
      topicId: oldTopic,
    },
    {
      userMessage: "Now, how do I add rate limiting?",
      assistantMessage: "Use @fastify/rate-limit.",
      turnSignal: "substantive",
      topicId: newTopic,
    },
  ]);

  const rendered = await history.renderCompacted(sessionId, 100_000);

  t.is(
    rendered.turnsCollapsed,
    6,
    "old-topic turns collapsed (ack + substantive)",
  );
  t.is(
    rendered.turnsKept,
    2,
    "pinned fallback ack and trailing new-topic turn kept",
  );

  const completedTopicCollapsed = await db
    .collection("turns")
    .find({ sessionId, state: "collapsed", collapsedBy: "completed_topic" })
    .toArray();

  t.is(
    completedTopicCollapsed.length,
    2,
    "substantive old-topic turns collapsed by completed_topic",
  );
  t.true(completedTopicCollapsed.every((t) => t.topicId === oldTopic));
});

test("compaction: correction turn on a completed topic survives", async (t) => {
  const sessionId = "compact-correction-old-topic";
  const history = new HistoryManager(db);

  const oldTopic = "topic-framework-choice";
  const newTopic = "topic-cors";

  await seedTurns(sessionId, [
    {
      userMessage: "Help me set up Express.",
      assistantMessage: "Run npm install express.",
      turnSignal: "substantive",
      topicId: oldTopic,
    },
    {
      userMessage: "No — Fastify, not Express.",
      assistantMessage: "Apologies! Let's set up Fastify instead.",
      turnSignal: "correction",
      topicId: oldTopic,
    },
    {
      userMessage: "Now add CORS.",
      assistantMessage: "Use @fastify/cors.",
      turnSignal: "substantive",
      topicId: newTopic,
    },
  ]);

  const rendered = await history.renderCompacted(sessionId, 100_000);

  t.is(rendered.turnsCollapsed, 1);
  t.is(rendered.turnsKept, 2);

  const correctionKept = rendered.messages.some(
    (m) =>
      typeof m.content === "string" &&
      m.content.includes("Fastify, not Express"),
  );
  t.true(correctionKept, "correction turn content present in rendered output");
});

test("compaction: completed_topic does not collapse a turn with an inactive belief", async (t) => {
  const sessionId = "compact-completed-inactive-belief";
  const history = new HistoryManager(db);

  const inactiveBeliefId = `inactive-${randomUUID()}`;
  await db.collection<Belief>("beliefs").insertOne({
    _id: inactiveBeliefId,
    user_id: USER_ID,
    type: "entity",
    canonical_name: "old-framework",
    content: "Was using Express",
    why_it_matters: "Superseded by Fastify decision",
    scope: ["coding"],
    provenance: {
      session_id: "seed",
      turn_id: "seed",
      extracted_at: new Date(),
      source_model: "seed",
    },
    epistemic_status: "superseded",
    confidence: 0.5,
    reinforcement_count: 0,
    last_reinforced_at: new Date(),
    pinned: false,
    user_edited: false,
    resolved_at: new Date(),
    superseded_by: BELIEF_ID.commitmentFastify,
    created_at: new Date(),
    updated_at: new Date(),
    change_log: [],
    subtype: null,
    aliases: [],
  });

  const oldTopic = "topic-old";
  const newTopic = "topic-new";

  await seedTurns(sessionId, [
    {
      userMessage: "We were using Express before.",
      assistantMessage: "Got it, Express is configured.",
      turnSignal: "substantive",
      hasNewBeliefs: true,
      beliefCandidateIds: [inactiveBeliefId],
      topicId: oldTopic,
    },
    {
      userMessage: "Now we switched to Fastify.",
      assistantMessage: "Got it, setting up Fastify.",
      turnSignal: "substantive",
      topicId: newTopic,
    },
  ]);

  const rendered = await history.renderCompacted(sessionId, 100_000);

  t.is(rendered.turnsCollapsed, 0);
  t.is(rendered.turnsKept, 2);

  await db.collection<Belief>("beliefs").deleteOne({ _id: inactiveBeliefId });
});

test("long session: topic drift, always-on injection, world model updates, compaction idempotency", async (t) => {
  const SESSION = "long-session-drift";
  const ALWAYS_ON_BELIEF_ID = "always-on-short-responses";

  const now = new Date();
  await db.collection<Belief>("beliefs").insertOne({
    _id: ALWAYS_ON_BELIEF_ID,
    user_id: USER_ID,
    type: "preference",
    canonical_name: "response-style",
    aliases: ["verbosity"],
    content: "Prefers short, direct responses — no preamble",
    why_it_matters: "Affects tone and length of every reply",
    scope: ["coding", "general"],
    provenance: {
      session_id: "seed",
      turn_id: "seed",
      extracted_at: now,
      source_model: "seed",
    },
    epistemic_status: "active",
    confidence: 0.92,
    reinforcement_count: 0,
    last_reinforced_at: now,
    pinned: true,
    user_edited: false,
    resolved_at: null,
    superseded_by: null,
    created_at: now,
    updated_at: now,
    change_log: [],
    subtype: null,
  });

  const callSpy = sinon.stub();

  callSpy.onCall(0).resolves({
    content:
      "Fastify uses a plugin-per-domain pattern for routing." +
      sc({
        turn_signal: "substantive",
        new_beliefs: [
          {
            type: "PREFERENCE",
            canonical_name: "error-handling-style",
            content:
              "Prefers centralised error handler over per-route try-catch",
            why_it_matters: "Affects all route scaffolding suggestions",
            scope: ["coding"],
            confidence: 0.85,
          },
        ],
        belief_updates: [],
        new_open_questions: [],
      }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  callSpy.onCall(1).resolves({
    content:
      "Register plugins with fastify.register() and scope them with prefixes." +
      sc({ turn_signal: "substantive", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  callSpy.onCall(2).resolves({
    content:
      "You could use JWT or session cookies — depends on your client type." +
      sc({
        turn_signal: "substantive",
        new_beliefs: [],
        belief_updates: [],
        new_open_questions: [
          {
            canonical_name: "auth-strategy",
            content: "JWT vs session cookies for auth",
            scope: ["coding"],
          },
        ],
      }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  callSpy.onCall(3).resolves({
    content:
      "Use @fastify/autoload to scan a routes/ directory automatically." +
      sc({ turn_signal: "substantive", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  callSpy.onCall(4).resolves({
    content: "👍" + sc({ turn_signal: "acknowledgment", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5 },
  } satisfies NormalizedResponse);

  callSpy.onCall(5).resolves({
    content: "Sure." + sc({ turn_signal: "acknowledgment", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5 },
  } satisfies NormalizedResponse);

  callSpy.onCall(6).resolves({
    content: "Yep." + sc({ turn_signal: "acknowledgment", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5 },
  } satisfies NormalizedResponse);

  callSpy.onCall(7).resolves({
    content:
      "Use a multi-stage Dockerfile: build stage with tsc, runtime with node:alpine." +
      sc({
        turn_signal: "substantive",
        new_beliefs: [],
        belief_updates: [
          {
            belief_id: "auth-strategy",
            change: "supersede",
            new_content: "Using JWT — decided",
          },
        ],
        new_open_questions: [],
      }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 30 },
  } satisfies NormalizedResponse);

  callSpy.onCall(8).resolves({
    content:
      "Apologies — use node:22-alpine, not node:alpine, to pin the major version." +
      sc({ turn_signal: "correction", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  callSpy.onCall(9).resolves({
    content:
      "Set NODE_ENV=production and run npm ci --omit=dev in the runtime stage." +
      sc({ turn_signal: "substantive", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
  } satisfies NormalizedResponse);

  callSpy.onCall(10).resolves({
    content:
      "Expose port 3000 and add a HEALTHCHECK with curl." +
      sc({ turn_signal: "substantive", ...EMPTY_SC }),
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 15 },
  } satisfies NormalizedResponse);

  const registry = new ProviderRegistry();
  registry.register({ id: PROVIDER_ID, call: callSpy });

  const reader = new BeliefsReader(db.collection("beliefs"));
  sinon.stub(reader, "searchText").resolves([]);

  const history = new HistoryManager(db);

  const extractionWorker = {
    sweep: async () => 0,
    processById: async (_jobId: string) => {},
  };

  const app = Fastify();
  registerChatRoute(app, {
    sessions: new SessionManager(db),
    history,
    context: new ContextBuilder(reader, NULL_PERSONA),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  const TOPIC_ROUTING = "topic-routing";
  const TOPIC_DOCKER = "topic-docker";

  async function replayAndTag(
    userMessage: string,
    topicId: string,
    turnIndex: number,
  ) {
    const res = await replay(app, SESSION, userMessage);
    t.is(res.statusCode, 200, `turn ${turnIndex}: status`);
    await waitForTurns(SESSION, turnIndex + 1);
    await db
      .collection("turns")
      .updateOne({ sessionId: SESSION, turnIndex }, { $set: { topicId } });
    return JSON.parse(res.body);
  }

  await replayAndTag(
    "How should I structure routes in Fastify?",
    TOPIC_ROUTING,
    0,
  );
  await replayAndTag(
    "How does fastify.register() work with prefixes?",
    TOPIC_ROUTING,
    1,
  );
  await replayAndTag(
    "What auth approach should I use — JWT or cookies?",
    TOPIC_ROUTING,
    2,
  );
  await replayAndTag(
    "Is there a way to autoload routes from a directory?",
    TOPIC_ROUTING,
    3,
  );

  await replayAndTag("got it", TOPIC_ROUTING, 4);
  await replayAndTag("ok", TOPIC_ROUTING, 5);
  await replayAndTag("thanks", TOPIC_ROUTING, 6);

  await replayAndTag(
    "Now I want to Dockerise the app — what's a good Dockerfile?",
    TOPIC_DOCKER,
    7,
  );
  await replayAndTag(
    "actually use node:22-alpine not node:alpine",
    TOPIC_DOCKER,
    8,
  );
  await replayAndTag(
    "What about env vars and dependencies in the runtime stage?",
    TOPIC_DOCKER,
    9,
  );
  await replayAndTag("How do I add a healthcheck?", TOPIC_DOCKER, 10);

  t.is(callSpy.callCount, 11, "all 11 turns reached the provider");

  for (let i = 0; i < 11; i++) {
    const systemPrompt = flattenSystemPrompt(callSpy.getCall(i).args[1]);
    t.true(
      systemPrompt.includes("response-style"),
      `turn ${i}: always-on PREFERENCE belief injected`,
    );
    t.true(
      systemPrompt.includes("web-framework"),
      `turn ${i}: COMMITMENT belief injected`,
    );
  }

  const allTurns = await waitForTurns(SESSION, 11);

  t.is(allTurns.length, 11, "all 11 turns persisted");

  t.true(
    allTurns[0].hasNewBeliefs,
    "turn 0: hasNewBeliefs from extracted PREFERENCE",
  );
  t.false(allTurns[1].hasNewBeliefs, "turn 1: no new beliefs");
  t.true(
    allTurns[2].hasOpenQuestion,
    "turn 2: hasOpenQuestion from auth-strategy",
  );

  t.is(allTurns[4].turnSignal, "acknowledgment", "turn 4: ack");
  t.is(allTurns[5].turnSignal, "acknowledgment", "turn 5: ack");
  t.is(allTurns[6].turnSignal, "acknowledgment", "turn 6: ack");

  t.false(
    allTurns[7].hasNewBeliefs,
    "turn 7: belief_updates do not set hasNewBeliefs (known gap)",
  );
  t.is(allTurns[8].turnSignal, "correction", "turn 8: correction signal");

  const jobs = await db
    .collection("jobs")
    .find({ session_id: SESSION })
    .sort({ created_at: 1 })
    .toArray();

  t.is(jobs.length, 11, "one extraction job per turn");
  t.true(
    jobs.every((j) => j.status === "pending"),
    "all jobs pending",
  );
  t.is(jobs[0].payload.parse_status, "parsed", "turn 0 job: parsed");
  t.is(
    jobs[2].payload.parse_status,
    "parsed",
    "turn 2 job: parsed (open question)",
  );
  t.is(
    jobs[7].payload.parse_status,
    "parsed",
    "turn 7 job: parsed (belief_update)",
  );

  t.truthy(jobs[7].payload.sidecar, "turn 7 job: sidecar present");
  const sidecar7 = JSON.parse(jobs[7].payload.sidecar);
  t.is(
    sidecar7.belief_updates?.[0]?.belief_id,
    "auth-strategy",
    "belief_update id preserved",
  );
  t.is(
    sidecar7.belief_updates?.[0]?.change,
    "supersede",
    "belief_update change preserved",
  );

  const rendered = await history.renderCompacted(SESSION, 100_000);

  t.is(
    rendered.turnsCollapsed,
    5,
    "5 turns collapsed (acks + old-topic turns with belief candidates)",
  );
  t.is(
    rendered.turnsKept,
    6,
    "6 turns kept (incl. pending-extraction turn with empty candidates)",
  );

  const renderedContent = rendered.messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");

  t.true(
    renderedContent.includes("node:22-alpine"),
    "correction turn in rendered output",
  );
  t.true(
    renderedContent.includes("NODE_ENV=production"),
    "turn 9 in rendered output",
  );
  t.true(renderedContent.includes("HEALTHCHECK"), "turn 10 in rendered output");

  const rendered2 = await history.renderCompacted(SESSION, 100_000);
  t.is(
    rendered2.turnsCollapsed,
    rendered.turnsCollapsed,
    "second pass: turnsCollapsed unchanged",
  );
  t.is(
    rendered2.turnsKept,
    rendered.turnsKept,
    "second pass: turnsKept unchanged",
  );

  await db.collection("beliefs").updateOne(
    { canonical_name: "auth-strategy", user_id: USER_ID },
    {
      $set: {
        superseded_by: "auth-strategy-resolved",
        updated_at: new Date(),
      },
    },
  );

  const freshCtx = await new ContextBuilder(
    new BeliefsReader(db.collection("beliefs")),
    NULL_PERSONA,
  ).build(USER_ID, ["coding"], "");

  const openQuestions = JSON.parse(freshCtx.openQuestionsJson);
  t.false(
    openQuestions.some((q: any) => q.canonical_name === "auth-strategy"),
    "superseded open question excluded from context after worker update",
  );

  await db
    .collection<Belief>("beliefs")
    .deleteOne({ _id: ALWAYS_ON_BELIEF_ID });
});

import anyTest, { type TestFn } from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Collection, MongoClient, type Db } from "mongodb";
import sinon from "sinon";

import { registerChatRoute, type ChatDeps } from "../routes/chat.js";
import { SessionManager } from "../session/manager.js";
import { HistoryManager } from "../history/manager.js";
import { ContextBuilder } from "../context/contextBuilder.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ExtractionJobQueue } from "../jobs/queue.js";
import type {
  NormalizedResponse,
  ProviderAdapter,
  StreamEvent,
} from "../providers/types.ts";
import { SIDECAR_BEGIN, SIDECAR_END } from "../sidecar/splitter.js";
import { ExtractionWorker } from "../extraction/worker.js";
import { RuntimeConfigStore } from "../config/runtime.ts";
import { ErrorLogger } from "../errors/logger.ts";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  await db.collection("turns").createIndex({ content: "text" });
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    db.collection("sessions").deleteMany({}),
    db.collection("turns").deleteMany({}),
    db.collection("jobs").deleteMany({}),
    db.collection("beliefs").deleteMany({}),
  ]);

  const start = Date.now();
  while (Date.now() - start < 500) {
    await new Promise((r) => setTimeout(r, 30));
    const n = await db.collection("turns").countDocuments({});
    if (n === 0) break;
    await db.collection("turns").deleteMany({});
  }
});

const USER_ID = "user-integration";
const SESSION_ID = "session-integration";
const PROVIDER_ID = "anthropic";
const MODEL = "claude-haiku-4-5-20251001";

function makeProviderResponse(
  content: string,
  overrides: Partial<NormalizedResponse> = {},
): NormalizedResponse {
  return {
    content,
    model: MODEL,
    provider: PROVIDER_ID,
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 20 },
    ...overrides,
  };
}

function makeStubAdapter(response: NormalizedResponse): ProviderAdapter {
  return {
    id: PROVIDER_ID,
    call: sinon.stub().resolves(response),
  };
}

function makeSidecar(turnSignal = "substantive", extras: object = {}): string {
  const payload = {
    turn_signal: turnSignal,
    new_beliefs: [],
    belief_updates: [],
    ...extras,
  };
  return `${SIDECAR_BEGIN}\n${JSON.stringify(payload)}\n${SIDECAR_END}`;
}

async function buildApp(
  adapterOrResponse: ProviderAdapter | NormalizedResponse,
): Promise<{
  app: FastifyInstance;
  deps: ChatDeps;
}> {
  const adapter =
    "id" in adapterOrResponse
      ? (adapterOrResponse as ProviderAdapter)
      : makeStubAdapter(adapterOrResponse as NormalizedResponse);

  const registry = new ProviderRegistry();
  registry.register(adapter);

  const sessions = new SessionManager(db);
  const history = new HistoryManager(db);
  const context = new ContextBuilder(
    {
      listByScope: sinon.stub().resolves([]),
      listPinnedOpenQuestions: sinon.stub().resolves([]),
    } as any,
    { get: sinon.stub().resolves(null) } as any,
  );
  const jobs = new ExtractionJobQueue(db);
  const extractionWorker = {
    processById: sinon.stub().resolves(),
    sweep: sinon.stub().resolves(0),
  };

  const runtimeStore = {
    load: sinon.stub().resolves({ extraction_enabled: true }),
    set: sinon.stub().resolves(),
  };

  const deps: ChatDeps = {
    sessions,
    history,
    context,
    providers: registry,
    jobs,
    userId: USER_ID,
    extractionWorker: extractionWorker as unknown as ExtractionWorker,
    runtimeStore: runtimeStore as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  };

  const app = Fastify();
  registerChatRoute(app, deps);
  await app.ready();

  await sessions.getOrCreate(SESSION_ID, USER_ID);
  await sessions.update(SESSION_ID, USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
  });

  return { app, deps };
}

async function post(
  app: FastifyInstance,
  body: object,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: {
      "content-type": "application/json",
      "x-session-id": SESSION_ID,
      ...headers,
    },
    body: JSON.stringify({ model: MODEL, ...body }),
  });
}

function streamEvents(
  deltas: string[],
  end: Partial<StreamEvent> = {},
): StreamEvent[] {
  return [
    ...deltas.map((d): StreamEvent => ({ type: "content_delta", delta: d })),
    {
      type: "stream_end",
      model: end.model ?? MODEL,
      finish_reason: end.finish_reason ?? "stop",
      usage: end.usage ?? { input_tokens: 15, output_tokens: 25 },
    },
  ];
}

function makeStreamAdapter(events: StreamEvent[]): ProviderAdapter {
  return {
    id: PROVIDER_ID,
    call: sinon.stub().resolves(makeProviderResponse("non-stream fallback")),
    async *callStream() {
      for (const e of events) yield e;
    },
  };
}

function failingStreamAdapter(
  preErrorDeltas: string[],
  error: Error,
): ProviderAdapter {
  return {
    id: PROVIDER_ID,
    call: sinon.stub().resolves(makeProviderResponse("non-stream fallback")),
    async *callStream() {
      for (const d of preErrorDeltas) {
        yield { type: "content_delta" as const, delta: d };
      }
      throw error;
    },
  };
}

interface SSEFrame {
  id?: string;
  object?: string;
  model?: string;
  created?: number;
  choices?: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; type: string };
}

function parseSSE(body: string): { frames: SSEFrame[]; done: boolean } {
  const frames: SSEFrame[] = [];
  let done = false;
  for (const chunk of body.split("\n\n")) {
    const line = chunk.trim();
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") {
      done = true;
      continue;
    }
    frames.push(JSON.parse(payload) as SSEFrame);
  }
  return { frames, done };
}

function concatDeltas(frames: SSEFrame[]): string {
  return frames.map((f) => f.choices?.[0]?.delta?.content ?? "").join("");
}

async function waitForDoc(
  col: Collection,
  filter: Record<string, unknown>,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const doc = await col.findOne(filter);
    if (doc) return doc as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

test("returns 200 with a well-formed chat completion envelope", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Hello!"));
  const res = await post(app, {
    messages: [{ role: "user", content: "Hi" }],
  });
  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
  t.is(body.choices[0].message.role, "assistant");
  t.is(body.choices[0].message.content, "Hello!");
  t.is(body.choices[0].finish_reason, "stop");
  t.is(body.usage.prompt_tokens, 10);
  t.is(body.usage.completion_tokens, 20);
  t.is(body.usage.total_tokens, 30);
});

test("sidecar is stripped from visible content", async (t) => {
  const sidecar = makeSidecar("substantive");
  const { app } = await buildApp(
    makeProviderResponse(`The answer is 42.\n${sidecar}`),
  );
  const res = await post(app, {
    messages: [{ role: "user", content: "What is the answer?" }],
  });
  const body = JSON.parse(res.body);
  t.is(body.choices[0].message.content, "The answer is 42.");
  t.false(body.choices[0].message.content.includes(SIDECAR_BEGIN));
});

test("turn is written to history after a successful call", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Stored."));
  await post(app, { messages: [{ role: "user", content: "Remember this" }] });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Remember this",
  });
  t.truthy(turn);
  t.is(turn!.assistantMessage, "Stored.");
});

test("extraction job is enqueued after a successful call", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Queued."));
  await post(app, { messages: [{ role: "user", content: "Queue me" }] });

  const job = await waitForDoc(db.collection("jobs"), {
    "payload.user_message": "Queue me",
  });
  t.truthy(job);
  t.is((job as any)!.payload.assistant_message, "Queued.");
  t.is(job!.status, "pending");
});

test("turn and job share the same turnId", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Linked."));
  await post(app, {
    messages: [{ role: "user", content: "Link" }],
  });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Link",
  });
  t.truthy(turn);

  const job = await waitForDoc(db.collection("jobs"), {
    turn_id: turn!._id as string,
  });
  t.truthy(job);
  t.is(turn!._id, job!.turn_id);
});

test("session lastUsedAt is touched after a successful call", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate(SESSION_ID, USER_ID);
  const before = (await sessions.get(SESSION_ID, USER_ID))!.lastUsedAt;

  await new Promise((r) => setTimeout(r, 10));

  const { app } = await buildApp(makeProviderResponse("Touched."));
  await post(app, { messages: [{ role: "user", content: "Touch" }] });

  await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Touch",
  });

  const after = (await sessions.get(SESSION_ID, USER_ID))!.lastUsedAt;
  t.true(after > before);
});

test("second turn gets turnIndex 1", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Reply."));
  await post(app, { messages: [{ role: "user", content: "First" }] });
  await post(app, { messages: [{ role: "user", content: "Second" }] });

  await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Second",
  });

  const turns = await db
    .collection("turns")
    .find({ sessionId: SESSION_ID })
    .sort({ turnIndex: 1 })
    .toArray();
  t.is(turns.length, 2);
  t.is(turns[0].turnIndex, 0);
  t.is(turns[1].turnIndex, 1);
});

test("hasNewBeliefs is true when sidecar contains new_beliefs", async (t) => {
  const sidecar = makeSidecar("substantive", {
    new_beliefs: [
      {
        type: "FACT",
        canonical_name: "x",
        content: "y",
        why_it_matters: "z",
        scope: [],
        confidence: 0.9,
      },
    ],
  });
  const { app } = await buildApp(makeProviderResponse(`Answer.\n${sidecar}`));
  await post(app, { messages: [{ role: "user", content: "Tell me a fact" }] });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    hasNewBeliefs: true,
  });
  t.truthy(turn);
});

test("hasOpenQuestion is true when sidecar contains new_open_questions", async (t) => {
  const sidecar = makeSidecar("substantive", {
    new_open_questions: [{ canonical_name: "q", content: "What?", scope: [] }],
  });
  const { app } = await buildApp(makeProviderResponse(`Answer.\n${sidecar}`));
  await post(app, { messages: [{ role: "user", content: "Any questions?" }] });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    hasOpenQuestion: true,
  });
  t.truthy(turn);
});

test("returns 400 when messages array is missing", async (t) => {
  const { app } = await buildApp(makeProviderResponse("x"));
  const res = await post(app, {});
  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.truthy(body.error?.message);
});

test("returns 400 when messages array is empty", async (t) => {
  const { app } = await buildApp(makeProviderResponse("x"));
  const res = await post(app, { messages: [] });
  t.is(res.statusCode, 400);
});

test("auto-binds unbound session and returns 200", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("unbound-session", USER_ID);

  const adapter = makeStubAdapter(makeProviderResponse("Auto-bound!"));
  const registry = new ProviderRegistry();
  registry.register(adapter);

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "Hi" }] },
    { "x-session-id": "unbound-session" },
  );
  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Auto-bound!");

  const bound = await sessions.get("unbound-session", USER_ID);
  t.is(bound!.providerId, PROVIDER_ID);
  t.is(bound!.model, MODEL);
});

test("returns 502 when provider throws", async (t) => {
  const failingAdapter: ProviderAdapter = {
    id: PROVIDER_ID,
    call: sinon.stub().rejects(new Error("upstream down")),
  };
  const { app } = await buildApp(failingAdapter);
  const res = await post(app, {
    messages: [{ role: "user", content: "Hi" }],
  });
  t.is(res.statusCode, 502);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "provider_error");
  t.is(body.error.message, "upstream down");
});

test("returns 502 when provider is not registered", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-unregistered", USER_ID);

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: new ProviderRegistry(),
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "Hi" }] },
    { "x-session-id": "sess-unregistered" },
  );
  t.is(res.statusCode, 502);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "provider_not_configured");
});

test("response is still returned when side-effect writes fail", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Still works."));
  sinon.stub(deps.history, "appendTurn").rejects(new Error("mongo down"));
  sinon.stub(deps.jobs, "enqueue").rejects(new Error("mongo down"));

  const res = await post(app, {
    messages: [{ role: "user", content: "Hi" }],
  });
  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Still works.");
});

test("response is still returned when context assembly fails", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Still works."));
  sinon.stub(deps.context, "build").rejects(new Error("beliefs db down"));

  const res = await post(app, {
    messages: [{ role: "user", content: "Hi" }],
  });
  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Still works.");
});

test("response is still returned when history window fetch fails", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Still works."));
  sinon
    .stub(deps.history, "getCompactedWindow")
    .rejects(new Error("history down"));

  const res = await post(app, {
    messages: [{ role: "user", content: "Hi" }],
  });
  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Still works.");
});

test("streaming: returns 200 with text/event-stream content-type", async (t) => {
  const events = streamEvents(["Hello!"]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  });

  t.is(res.statusCode, 200);
  t.is(res.headers["content-type"], "text/event-stream");
  t.is(res.headers["cache-control"], "no-cache");
});

test("streaming: response body terminates with data: [DONE]", async (t) => {
  const events = streamEvents(["Done."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  });

  const { done } = parseSSE(res.body);
  t.true(done);
  t.true(res.body.trimEnd().endsWith("data: [DONE]"));
});

test("streaming: first frame contains assistant role delta", async (t) => {
  const events = streamEvents(["Hi"]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Hello" }],
  });

  const { frames } = parseSSE(res.body);
  t.true(frames.length >= 2);
  t.is(frames[0].choices![0].delta.role, "assistant");
  t.is(frames[0].choices![0].delta.content, "");
});

test("streaming: all frames share the same chatcmpl-* id", async (t) => {
  const events = streamEvents(["A", "B", "C"]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Go" }],
  });

  const { frames } = parseSSE(res.body);
  const ids = new Set(frames.map((f) => f.id));
  t.is(ids.size, 1);
  t.regex([...ids][0]!, /^chatcmpl-/);
});

test("streaming: all frames have object chat.completion.chunk", async (t) => {
  const events = streamEvents(["X"]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Go" }],
  });

  const { frames } = parseSSE(res.body);
  for (const frame of frames) {
    t.is(frame.object, "chat.completion.chunk");
  }
});

test("streaming: content deltas reconstruct the full visible message", async (t) => {
  const events = streamEvents([
    "This is a longer message that should ",
    "be flushed in parts because it exceeds ",
    "the holdback buffer significantly.",
  ]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Tell me something" }],
  });

  const { frames } = parseSSE(res.body);
  const reconstructed = concatDeltas(frames);

  t.is(
    reconstructed,
    "This is a longer message that should be flushed in parts because it exceeds the holdback buffer significantly.",
  );
});

test("streaming: short message below holdback is flushed after loop", async (t) => {
  const events = streamEvents(["Short."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  });

  const { frames } = parseSSE(res.body);
  const content = concatDeltas(frames);
  t.is(content, "Short.");
});

test("streaming: sidecar content never appears in any delta", async (t) => {
  const sidecarPayload = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [],
    belief_updates: [],
  });
  const events: StreamEvent[] = [
    { type: "content_delta", delta: "The answer is 42." },
    {
      type: "content_delta",
      delta: `\n${SIDECAR_BEGIN}\n`,
    },
    {
      type: "content_delta",
      delta: `${sidecarPayload}\n${SIDECAR_END}`,
    },
    {
      type: "stream_end",
      model: MODEL,
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 20 },
    },
  ];

  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "What is the answer?" }],
  });

  const { frames } = parseSSE(res.body);
  const fullContent = concatDeltas(frames);

  t.false(fullContent.includes(SIDECAR_BEGIN));
  t.false(fullContent.includes(SIDECAR_END));
  t.false(fullContent.includes("turn_signal"));
  t.false(fullContent.includes("new_beliefs"));
});

test("streaming: visible content before sidecar is flushed to client", async (t) => {
  const sidecar = makeSidecar("acknowledgment");
  const visiblePart =
    "Here is a detailed answer that is long enough to flush before the sidecar marker appears in the stream. ";

  const events: StreamEvent[] = [
    { type: "content_delta", delta: visiblePart },
    { type: "content_delta", delta: `\n${sidecar}` },
    {
      type: "stream_end",
      model: MODEL,
      finish_reason: "stop",
      usage: { input_tokens: 10, output_tokens: 30 },
    },
  ];

  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Explain" }],
  });

  const { frames } = parseSSE(res.body);
  const content = concatDeltas(frames);

  t.true(content.includes("Here is a detailed answer"));
  t.false(content.includes(SIDECAR_BEGIN));
});

test("streaming: final content frame has finish_reason and usage", async (t) => {
  const events = streamEvents(["Result."], {
    finish_reason: "stop",
    usage: { input_tokens: 42, output_tokens: 84 },
  });
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Go" }],
  });

  const { frames } = parseSSE(res.body);
  const last = frames[frames.length - 1];

  t.is(last.choices![0].finish_reason, "stop");
  t.is(last.usage!.prompt_tokens, 42);
  t.is(last.usage!.completion_tokens, 84);
  t.is(last.usage!.total_tokens, 126);
});

test("streaming: finish_reason length is propagated", async (t) => {
  const events = streamEvents(["Truncated"], {
    finish_reason: "length",
    usage: { input_tokens: 5, output_tokens: 100 },
  });
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Write a lot" }],
  });

  const { frames } = parseSSE(res.body);
  const last = frames[frames.length - 1];
  t.is(last.choices![0].finish_reason, "length");
});

test("streaming: turn is persisted after stream completes", async (t) => {
  const events = streamEvents(["Streamed answer."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Stream me" }],
  });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Stream me",
  });

  t.truthy(turn);
  t.is(turn!.assistantMessage, "Streamed answer.");
});

test("streaming: extraction job is enqueued after stream completes", async (t) => {
  const events = streamEvents(["Extracted."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Extract this" }],
  });

  const job = await waitForDoc(db.collection("jobs"), {
    "payload.user_message": "Extract this",
  });

  t.truthy(job);
  t.is((job as any).payload.assistant_message, "Extracted.");
  t.is(job!.status, "pending");
});

test("streaming: turn and job share the same turnId", async (t) => {
  const events = streamEvents(["Linked."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Link stream" }],
  });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Link stream",
  });
  t.truthy(turn);
  const job = await waitForDoc(db.collection("jobs"), {
    turn_id: turn!._id as string,
  });
  t.truthy(job);
  t.is(turn!._id, job!.turn_id);
});

test("streaming: session lastUsedAt is touched after stream", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate(SESSION_ID, USER_ID);
  const before = (await sessions.get(SESSION_ID, USER_ID))!.lastUsedAt;
  await new Promise((r) => setTimeout(r, 10));

  const events = streamEvents(["Touched."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Touch stream" }],
  });

  await new Promise((r) => setTimeout(r, 250));
  const after = (await sessions.get(SESSION_ID, USER_ID))!.lastUsedAt;
  t.true(after > before);
});

test("streaming: sidecar parse_status is captured on extraction job", async (t) => {
  const sidecar = makeSidecar("substantive");
  const events: StreamEvent[] = [
    { type: "content_delta", delta: `Visible.\n${sidecar}` },
    {
      type: "stream_end",
      model: MODEL,
      finish_reason: "stop",
      usage: { input_tokens: 5, output_tokens: 10 },
    },
  ];

  const { app } = await buildApp(makeStreamAdapter(events));

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Sidecar stream" }],
  });

  const job = await waitForDoc(db.collection("jobs"), {
    "payload.user_message": "Sidecar stream",
  });

  t.truthy(job);
  t.is((job as any)!.payload.parse_status, "parsed");
});

test("streaming: hasNewBeliefs flag set on turn when sidecar has beliefs", async (t) => {
  const sidecar = makeSidecar("substantive", {
    new_beliefs: [
      {
        type: "FACT",
        canonical_name: "x",
        content: "y",
        why_it_matters: "z",
        scope: [],
        confidence: 0.9,
      },
    ],
  });
  const events: StreamEvent[] = [
    { type: "content_delta", delta: `Answer.\n${sidecar}` },
    {
      type: "stream_end",
      model: MODEL,
      finish_reason: "stop",
      usage: { input_tokens: 5, output_tokens: 15 },
    },
  ];

  const { app } = await buildApp(makeStreamAdapter(events));

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Stream beliefs" }],
  });

  const turn = await waitForDoc(db.collection("turns"), {
    userMessage: "Stream beliefs",
  });

  t.truthy(turn);
  t.true(turn!.hasNewBeliefs as boolean);
});

test("streaming: provider error mid-stream emits error frame then [DONE]", async (t) => {
  const adapter = failingStreamAdapter(
    ["partial content"],
    new Error("connection reset"),
  );
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Fail" }],
  });

  const { frames, done } = parseSSE(res.body);
  t.true(done);

  const errorFrame = frames.find((f) => f.error != null);
  t.truthy(errorFrame);
  t.is(errorFrame!.error!.message, "connection reset");
  t.is(errorFrame!.error!.type, "provider_error");
});

test("streaming: no turn or job written on provider error", async (t) => {
  const adapter = failingStreamAdapter(
    ["partial"],
    new Error("upstream crash"),
  );
  const { app } = await buildApp(adapter);

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Error no persist" }],
  });

  await new Promise((r) => setTimeout(r, 250));

  const turn = await db
    .collection("turns")
    .findOne({ userMessage: "Error no persist" });
  const job = await db
    .collection("jobs")
    .findOne({ "payload.user_message": "Error no persist" });

  t.is(turn, null);
  t.is(job, null);
});

test("streaming: falls back to non-streaming when adapter lacks callStream", async (t) => {
  const adapter: ProviderAdapter = {
    id: PROVIDER_ID,
    call: sinon.stub().resolves(makeProviderResponse("Non-streamed.")),
  };
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Hi" }],
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
  t.is(body.choices[0].message.content, "Non-streamed.");
});

test("streaming: model from stream_end is used in final frame", async (t) => {
  const events = streamEvents(["Ok."], {
    model: "claude-sonnet-4-20250514",
  });
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Which model?" }],
  });

  const { frames } = parseSSE(res.body);
  const last = frames[frames.length - 1];
  t.is(last.model, "claude-sonnet-4-20250514");
});

test("extraction worker processById is called after a successful turn", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Processed."));
  const spy = deps.extractionWorker.processById as sinon.SinonStub;

  const res = await post(app, {
    messages: [{ role: "user", content: "Trigger worker" }],
  });
  t.is(res.statusCode, 200);

  await new Promise((r) => setTimeout(r, 50));

  t.true(spy.calledOnce, "processById called once");

  const job = await db.collection("jobs").findOne({
    "payload.user_message": "Trigger worker",
  });
  t.truthy(job);
  t.is(spy.firstCall.args[0], job!._id, "called with the enqueued job id");
});

test("extraction worker processById is NOT called when job enqueue fails", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Still works."));
  sinon.stub(deps.jobs, "enqueue").rejects(new Error("queue down"));
  const spy = deps.extractionWorker.processById as sinon.SinonStub;

  const res = await post(app, {
    messages: [{ role: "user", content: "No worker call" }],
  });
  t.is(res.statusCode, 200);
  await new Promise((r) => setTimeout(r, 50));

  t.false(spy.called, "processById not called when enqueue fails");
});

test("extraction worker is NOT called when extraction_enabled is false", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("No extraction."));

  (deps.runtimeStore.load as sinon.SinonStub).resolves({
    extraction_enabled: false,
  });

  const spy = deps.extractionWorker.processById as sinon.SinonStub;

  const res = await post(app, {
    messages: [{ role: "user", content: "Don't extract this" }],
  });
  t.is(res.statusCode, 200);

  await new Promise((r) => setTimeout(r, 50));
  t.false(spy.called, "processById not called when extraction disabled");
});

test("no extraction job enqueued when extraction_enabled is false", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("No job."));

  (deps.runtimeStore.load as sinon.SinonStub).resolves({
    extraction_enabled: false,
  });

  await post(app, {
    messages: [{ role: "user", content: "No job please" }],
  });

  await new Promise((r) => setTimeout(r, 100));

  const job = await db
    .collection("jobs")
    .findOne({ "payload.user_message": "No job please" });
  t.is(job, null);
});

test("turn is still persisted when extraction_enabled is false", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Still stored."));

  (deps.runtimeStore.load as sinon.SinonStub).resolves({
    extraction_enabled: false,
  });

  await post(app, {
    messages: [{ role: "user", content: "Store me anyway" }],
  });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Store me anyway",
  });
  t.truthy(turn);
  t.is(turn!.assistantMessage, "Still stored.");
});

test("streaming: extraction worker NOT called when extraction_enabled is false", async (t) => {
  const events = streamEvents(["No extract stream."]);
  const { app, deps } = await buildApp(makeStreamAdapter(events));

  (deps.runtimeStore.load as sinon.SinonStub).resolves({
    extraction_enabled: false,
  });

  const spy = deps.extractionWorker.processById as sinon.SinonStub;

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Stream no extract" }],
  });

  await new Promise((r) => setTimeout(r, 100));
  t.false(
    spy.called,
    "processById not called on streaming when extraction disabled",
  );
});

test("streaming: turn still persisted when extraction_enabled is false", async (t) => {
  const events = streamEvents(["Stored anyway."]);
  const { app, deps } = await buildApp(makeStreamAdapter(events));

  (deps.runtimeStore.load as sinon.SinonStub).resolves({
    extraction_enabled: false,
  });

  await post(app, {
    stream: true,
    messages: [{ role: "user", content: "Stream store me" }],
  });

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: SESSION_ID,
    userMessage: "Stream store me",
  });
  t.truthy(turn);
  t.is(turn!.assistantMessage, "Stored anyway.");
});

test("response still returned when runtimeStore.load fails", async (t) => {
  const { app, deps } = await buildApp(makeProviderResponse("Still works."));

  (deps.runtimeStore.load as sinon.SinonStub).rejects(
    new Error("config db down"),
  );

  const res = await post(app, {
    messages: [{ role: "user", content: "Config failure" }],
  });

  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Still works.");
});

test("!scope command returns synthetic acknowledgment without calling LLM", async (t) => {
  const adapter = makeStubAdapter(
    makeProviderResponse("Should not be called."),
  );
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    messages: [{ role: "user", content: "!scope domain:code" }],
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
  t.is(body.choices[0].finish_reason, "stop");
  t.true(body.choices[0].message.content.includes("domain:code"));
  t.false((adapter.call as sinon.SinonStub).called);
});

test("!scope command updates session activeScope", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-scope-cmd", USER_ID);
  await sessions.update("sess-scope-cmd", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: [],
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!scope domain:writing" }] },
    { "x-session-id": "sess-scope-cmd" },
  );

  const updated = await sessions.get("sess-scope-cmd", USER_ID);
  t.deepEqual(updated!.activeScope, ["domain:writing"]);
});

test("!scope command tenure reflects new scope immediately", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  const res = await post(app, {
    messages: [{ role: "user", content: "!scope domain:code domain:writing" }],
  });

  const body = JSON.parse(res.body);
  t.deepEqual(body.tenure.scope, ["domain:code", "domain:writing"]);
});

test("!scope command tenure parse_status is missing since no LLM fired", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  const res = await post(app, {
    messages: [{ role: "user", content: "!scope domain:code" }],
  });

  const body = JSON.parse(res.body);
  t.is(body.tenure.parse_status, "missing");
});

test("!scope command tenure degraded is false", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  const res = await post(app, {
    messages: [{ role: "user", content: "!scope domain:code" }],
  });

  const body = JSON.parse(res.body);
  t.false(body.tenure.degraded);
});

test("!scope command does not write a turn to history", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  await post(app, {
    messages: [{ role: "user", content: "!scope domain:code" }],
  });

  await new Promise((r) => setTimeout(r, 150));

  const turn = await db.collection("turns").findOne({
    sessionId: SESSION_ID,
    userMessage: "!scope domain:code",
  });
  t.is(turn, null);
});

test("!scope command does not enqueue an extraction job", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  await post(app, {
    messages: [{ role: "user", content: "!scope domain:hobby" }],
  });

  await new Promise((r) => setTimeout(r, 150));

  const job = await db.collection("jobs").findOne({
    "payload.user_message": "!scope domain:hobby",
  });
  t.is(job, null);
});

test("!scope with no argument returns usage hint without calling LLM", async (t) => {
  const adapter = makeStubAdapter(makeProviderResponse("Unused."));
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    messages: [{ role: "user", content: "!scope" }],
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.choices[0].message.content.includes("No scope provided"));
  t.false((adapter.call as sinon.SinonStub).called);
});

test("set scope prefix also intercepts without calling LLM", async (t) => {
  const adapter = makeStubAdapter(makeProviderResponse("Unused."));
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    messages: [{ role: "user", content: "set scope domain:code" }],
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.choices[0].message.content.includes("domain:code"));
  t.false((adapter.call as sinon.SinonStub).called);
});

test("scope command mid-session changes scope for subsequent turn", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-mid-change", USER_ID);
  await sessions.update("sess-mid-change", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: ["domain:code"],
  });

  const adapter = makeStubAdapter(makeProviderResponse("Reply."));
  const registry = new ProviderRegistry();
  registry.register(adapter);

  const contextBuild = sinon.stub().resolves({
    personaPrelude: "",
    pinnedFactsJson: "[]",
    expandedQuery: "",
    queryWasNoisy: false,
    relevantBeliefsJson: "[]",
    openQuestionsJson: "[]",
    beliefCount: 0,
    questionCount: 0,
    truncated: false,
    searchScores: [],
  });

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: { build: contextBuild } as any,
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!scope domain:writing" }] },
    { "x-session-id": "sess-mid-change" },
  );

  await post(
    app,
    { messages: [{ role: "user", content: "What should I write next?" }] },
    { "x-session-id": "sess-mid-change" },
  );

  t.true(contextBuild.calledOnce);
  t.deepEqual(contextBuild.firstCall.args[1], ["domain:writing"]);
});

test("streaming: !scope command returns non-streaming JSON even when stream:true", async (t) => {
  const events = streamEvents(["Should not appear."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "!scope domain:code" }],
  });

  t.is(res.statusCode, 200);
  t.not(res.headers["content-type"], "text/event-stream");
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
  t.true(body.choices[0].message.content.includes("domain:code"));
});

test("first-turn scope detection runs when scopeDetector is configured and activeScope is empty", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-detect", USER_ID);
  await sessions.update("sess-detect", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: [],
  });

  const detectorCall = sinon.stub().resolves({
    content: '["domain:code"]',
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 5, output_tokens: 3 },
  });

  const mainAdapter = makeStubAdapter(makeProviderResponse("Main reply."));
  const registry = new ProviderRegistry();
  registry.register(mainAdapter);

  const contextBuild = sinon.stub().resolves({
    personaPrelude: "",
    pinnedFactsJson: "[]",
    expandedQuery: "",
    queryWasNoisy: false,
    relevantBeliefsJson: "[]",
    openQuestionsJson: "[]",
    beliefCount: 0,
    questionCount: 0,
    truncated: false,
    searchScores: [],
  });

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: { build: contextBuild } as any,
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
    scopeDetector: {
      db: db as any,
      adapter: () => ({ id: "openai", call: detectorCall }),
      modelId: "gpt-4o-mini",
    },
  });
  await app.ready();

  const res = await post(
    app,
    {
      messages: [
        { role: "user", content: "How do I structure my TypeScript project?" },
      ],
    },
    { "x-session-id": "sess-detect" },
  );

  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Main reply.");

  t.true(detectorCall.calledOnce);

  t.true(contextBuild.calledOnce);
  t.deepEqual(contextBuild.firstCall.args[1], ["domain:code"]);

  const updated = await sessions.get("sess-detect", USER_ID);
  t.deepEqual(updated!.activeScope, ["domain:code"]);
});

test("first-turn scope detection does not run when activeScope is already set", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-already-scoped", USER_ID);
  await sessions.update("sess-already-scoped", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: ["domain:code"],
  });

  const detectorCall = sinon.stub().resolves({
    content: '["domain:writing"]',
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 5, output_tokens: 3 },
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Reply.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
    scopeDetector: {
      db: db as any,
      adapter: () => ({ id: "openai", call: detectorCall }),
      modelId: "gpt-4o-mini",
    },
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "How do I write a novel?" }] },
    { "x-session-id": "sess-already-scoped" },
  );

  const body = JSON.parse(res.body);

  t.false(detectorCall.called);
});

test("first-turn scope detection does not run when scopeDetector is not configured", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-no-detector", USER_ID);
  await sessions.update("sess-no-detector", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: [],
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Reply.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "Hi there" }] },
    { "x-session-id": "sess-no-detector" },
  );

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
});

test("first-turn scope detection failure degrades gracefully and still returns response", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-detect-fail", USER_ID);
  await sessions.update("sess-detect-fail", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: [],
  });

  const detectorCall = sinon.stub().rejects(new Error("detector down"));

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Reply anyway.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
    scopeDetector: {
      db: db as any,
      adapter: () => ({ id: "openai", call: detectorCall }),
      modelId: "gpt-4o-mini",
    },
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "Still works?" }] },
    { "x-session-id": "sess-detect-fail" },
  );

  t.is(res.statusCode, 200);
  t.is(JSON.parse(res.body).choices[0].message.content, "Reply anyway.");
});

test("first-turn scope detection only fires on turnCounter 0", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-second-turn", USER_ID);
  await sessions.update("sess-second-turn", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    activeScope: [],
  });

  const detectorCall = sinon.stub().resolves({
    content: '["domain:code"]',
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 5, output_tokens: 3 },
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Reply.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
    scopeDetector: {
      db: db as any,
      adapter: () => ({ id: "openai", call: detectorCall }),
      modelId: "gpt-4o-mini",
    },
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "First message" }] },
    { "x-session-id": "sess-second-turn" },
  );

  await post(
    app,
    { messages: [{ role: "user", content: "Second message" }] },
    { "x-session-id": "sess-second-turn" },
  );

  t.is(detectorCall.callCount, 1);
});

test("!extract off returns synthetic acknowledgment without calling LLM", async (t) => {
  const adapter = makeStubAdapter(
    makeProviderResponse("Should not be called."),
  );
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    messages: [{ role: "user", content: "!extract off" }],
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
  t.is(body.choices[0].finish_reason, "stop");
  t.false((adapter.call as sinon.SinonStub).called);
});

test("!extract off does not write a turn to history", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  await post(app, {
    messages: [{ role: "user", content: "!extract off" }],
  });

  await new Promise((r) => setTimeout(r, 150));

  const turn = await db.collection("turns").findOne({
    sessionId: SESSION_ID,
    userMessage: "!extract off",
  });
  t.is(turn, null);
});

test("!extract off does not enqueue an extraction job", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  await post(app, {
    messages: [{ role: "user", content: "!extract off" }],
  });

  await new Promise((r) => setTimeout(r, 150));

  const job = await db.collection("jobs").findOne({
    "payload.user_message": "!extract off",
  });
  t.is(job, null);
});

test("!extract off sets extractionPaused on session", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-extract-off", USER_ID);
  await sessions.update("sess-extract-off", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!extract off" }] },
    { "x-session-id": "sess-extract-off" },
  );

  const updated = await sessions.get("sess-extract-off", USER_ID);
  t.true((updated as any).extractionPaused);
});

test("!extract on clears extractionPaused on session", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-extract-on", USER_ID);
  await sessions.update("sess-extract-on", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    extractionPaused: true,
  } as any);

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!extract on" }] },
    { "x-session-id": "sess-extract-on" },
  );

  const updated = await sessions.get("sess-extract-on", USER_ID);
  t.false((updated as any).extractionPaused);
});

test("!extract global off calls runtimeStore.set with extraction_enabled false", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const adapter = makeStubAdapter(makeProviderResponse("Unused."));
  const registry = new ProviderRegistry();
  registry.register(adapter);

  const app = Fastify();
  registerChatRoute(app, {
    sessions: new SessionManager(db),
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: runtimeSet,
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await db.collection("sessions").deleteMany({ _id: "sess-global-extract" });
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-global-extract", USER_ID);
  await sessions.update("sess-global-extract", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
  });

  const res = await post(
    app,
    { messages: [{ role: "user", content: "!extract global off" }] },
    { "x-session-id": "sess-global-extract" },
  );

  t.is(res.statusCode, 200);
  t.true(runtimeSet.calledWith("extraction_enabled", false));
  t.false((adapter.call as sinon.SinonStub).called);
});

test("extraction worker NOT called on subsequent turn when session extractionPaused is true", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-paused-extract", USER_ID);
  await sessions.update("sess-paused-extract", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    extractionPaused: true,
  } as any);

  const adapter = makeStubAdapter(makeProviderResponse("Normal reply."));
  const registry = new ProviderRegistry();
  registry.register(adapter);
  const extractionWorker = {
    processById: sinon.stub().resolves(),
    sweep: sinon.stub().resolves(0),
  };

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: extractionWorker as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "Normal question" }] },
    { "x-session-id": "sess-paused-extract" },
  );

  t.is(res.statusCode, 200);
  await new Promise((r) => setTimeout(r, 100));
  t.false(extractionWorker.processById.called);
});

test("turn still persisted on subsequent turn when session extractionPaused is true", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-paused-persist", USER_ID);
  await sessions.update("sess-paused-persist", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    extractionPaused: true,
  } as any);

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Stored.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon.stub().resolves({ extraction_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "Store this anyway" }] },
    { "x-session-id": "sess-paused-persist" },
  );

  const turn = await waitForDoc(db.collection("turns"), {
    sessionId: "sess-paused-persist",
    userMessage: "Store this anyway",
  });
  t.truthy(turn);
  t.is(turn!.assistantMessage, "Stored.");
});

test("streaming: !extract off returns non-streaming JSON even when stream:true", async (t) => {
  const events = streamEvents(["Should not appear."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "!extract off" }],
  });

  t.is(res.statusCode, 200);
  t.not(res.headers["content-type"], "text/event-stream");
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
});

test("!inject off returns synthetic acknowledgment without calling LLM", async (t) => {
  const adapter = makeStubAdapter(
    makeProviderResponse("Should not be called."),
  );
  const { app } = await buildApp(adapter);

  const res = await post(app, {
    messages: [{ role: "user", content: "!inject off" }],
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
  t.is(body.choices[0].finish_reason, "stop");
  t.false((adapter.call as sinon.SinonStub).called);
});

test("!inject off does not write a turn to history", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  await post(app, {
    messages: [{ role: "user", content: "!inject off" }],
  });

  await new Promise((r) => setTimeout(r, 150));

  const turn = await db.collection("turns").findOne({
    sessionId: SESSION_ID,
    userMessage: "!inject off",
  });
  t.is(turn, null);
});

test("!inject off does not enqueue an extraction job", async (t) => {
  const { app } = await buildApp(makeProviderResponse("Unused."));

  await post(app, {
    messages: [{ role: "user", content: "!inject off" }],
  });

  await new Promise((r) => setTimeout(r, 150));

  const job = await db.collection("jobs").findOne({
    "payload.user_message": "!inject off",
  });
  t.is(job, null);
});

test("!inject off sets injectionPaused on session", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-inject-off", USER_ID);
  await sessions.update("sess-inject-off", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!inject off" }] },
    { "x-session-id": "sess-inject-off" },
  );

  const updated = await sessions.get("sess-inject-off", USER_ID);
  t.true((updated as any).injectionPaused);
});

test("!inject on clears injectionPaused on session", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-inject-on", USER_ID);
  await sessions.update("sess-inject-on", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    injectionPaused: true,
  } as any);

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!inject on" }] },
    { "x-session-id": "sess-inject-on" },
  );

  const updated = await sessions.get("sess-inject-on", USER_ID);
  t.false((updated as any).injectionPaused);
});

test("!inject off: context.build is not called on subsequent turn", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-inject-no-build", USER_ID);
  await sessions.update("sess-inject-no-build", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    injectionPaused: true,
  } as any);

  const contextBuild = sinon.stub().resolves({
    personaPrelude: "",
    pinnedFactsJson: "[]",
    expandedQuery: "",
    queryWasNoisy: false,
    relevantBeliefsJson: "[]",
    openQuestionsJson: "[]",
    beliefCount: 0,
    questionCount: 0,
    truncated: false,
    searchScores: [],
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("No context.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: { build: contextBuild } as any,
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "Normal question" }] },
    { "x-session-id": "sess-inject-no-build" },
  );

  t.is(res.statusCode, 200);
  t.false(
    contextBuild.called,
    "context.build should be skipped when injectionPaused",
  );
});

test("!inject off: extraction still runs on subsequent turn", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-inject-off-extract", USER_ID);
  await sessions.update("sess-inject-off-extract", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    injectionPaused: true,
  } as any);

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Still extracts.")));
  const extractionWorker = {
    processById: sinon.stub().resolves(),
    sweep: sinon.stub().resolves(0),
  };

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: extractionWorker as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "Extract this please" }] },
    { "x-session-id": "sess-inject-off-extract" },
  );

  await new Promise((r) => setTimeout(r, 100));

  t.true(extractionWorker.processById.called);
});

test("!inject global off calls runtimeStore.set with injection_enabled false", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const adapter = makeStubAdapter(makeProviderResponse("Unused."));
  const registry = new ProviderRegistry();
  registry.register(adapter);

  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-global-inject", USER_ID);
  await sessions.update("sess-global-inject", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
  });

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: runtimeSet,
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  const res = await post(
    app,
    { messages: [{ role: "user", content: "!inject global off" }] },
    { "x-session-id": "sess-global-inject" },
  );

  t.is(res.statusCode, 200);
  t.true(runtimeSet.calledWith("injection_enabled", false));
  t.false((adapter.call as sinon.SinonStub).called);
});

test("streaming: !inject off returns non-streaming JSON even when stream:true", async (t) => {
  const events = streamEvents(["Should not appear."]);
  const { app } = await buildApp(makeStreamAdapter(events));

  const res = await post(app, {
    stream: true,
    messages: [{ role: "user", content: "!inject off" }],
  });

  t.is(res.statusCode, 200);
  t.not(res.headers["content-type"], "text/event-stream");
  const body = JSON.parse(res.body);
  t.is(body.object, "chat.completion");
});

test("!extract off and !inject off are independent: both can be set simultaneously", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-both-off", USER_ID);
  await sessions.update("sess-both-off", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
  });

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!extract off" }] },
    { "x-session-id": "sess-both-off" },
  );

  await post(
    app,
    { messages: [{ role: "user", content: "!inject off" }] },
    { "x-session-id": "sess-both-off" },
  );

  const updated = await sessions.get("sess-both-off", USER_ID);
  t.true((updated as any).extractionPaused);
  t.true((updated as any).injectionPaused);
});

test("!inject off does not affect extractionPaused field", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-inject-no-extract-change", USER_ID);
  await sessions.update("sess-inject-no-extract-change", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    extractionPaused: false,
  } as any);

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!inject off" }] },
    { "x-session-id": "sess-inject-no-extract-change" },
  );

  const updated = await sessions.get("sess-inject-no-extract-change", USER_ID);

  t.false((updated as any).extractionPaused);
  t.true((updated as any).injectionPaused);
});

test("!extract off does not affect injectionPaused field", async (t) => {
  const sessions = new SessionManager(db);
  await sessions.getOrCreate("sess-extract-no-inject-change", USER_ID);
  await sessions.update("sess-extract-no-inject-change", USER_ID, {
    providerId: PROVIDER_ID,
    model: MODEL,
    injectionPaused: false,
  } as any);

  const registry = new ProviderRegistry();
  registry.register(makeStubAdapter(makeProviderResponse("Unused.")));

  const app = Fastify();
  registerChatRoute(app, {
    sessions,
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as any,
    ),
    providers: registry,
    jobs: new ExtractionJobQueue(db),
    userId: USER_ID,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    runtimeStore: {
      load: sinon
        .stub()
        .resolves({ extraction_enabled: true, injection_enabled: true }),
      set: sinon.stub().resolves(),
    } as unknown as RuntimeConfigStore,
    errorLogger: {
      log: sinon.stub().resolves(),
    } as unknown as ErrorLogger,
  });
  await app.ready();

  await post(
    app,
    { messages: [{ role: "user", content: "!extract off" }] },
    { "x-session-id": "sess-extract-no-inject-change" },
  );

  const updated = await sessions.get("sess-extract-no-inject-change", USER_ID);

  t.false((updated as any).injectionPaused);
  t.true((updated as any).extractionPaused);
});

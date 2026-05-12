import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection, type Db } from "mongodb";
import { ExtractionJobQueue, type EnqueueParams } from "./queue.js";
import type { ExtractionJob } from "../types/job.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let col: Collection<ExtractionJob>;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  col = db.collection<ExtractionJob>("jobs");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await col.deleteMany({});
});

function makeParams(overrides: Partial<EnqueueParams> = {}): EnqueueParams {
  return {
    userId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    userMessage: "Hello",
    assistantMessage: "Hi there",
    sidecarRaw: null,
    parseStatus: "missing",
    scope: ["global"],
    sourceModel: "anthropic:claude-3-5-sonnet",
    ...overrides,
  };
}

test("enqueue returns a UUID string", async (t) => {
  const q = new ExtractionJobQueue(db);
  const id = await q.enqueue(makeParams());
  t.regex(id, /^[0-9a-f-]{36}$/i);
});

test("enqueue inserts exactly one document", async (t) => {
  const q = new ExtractionJobQueue(db);
  await q.enqueue(makeParams());
  t.is(await col.countDocuments(), 1);
});

test("enqueue returns unique ids for successive calls", async (t) => {
  const q = new ExtractionJobQueue(db);
  const a = await q.enqueue(makeParams());
  const b = await q.enqueue(makeParams());
  t.not(a, b);
});

test("inserted job has status pending", async (t) => {
  const q = new ExtractionJobQueue(db);
  const id = await q.enqueue(makeParams());
  const job = await col.findOne({ _id: id });
  t.is(job!.status, "pending");
});

test("inserted job has attempts=0 and max_attempts=3", async (t) => {
  const q = new ExtractionJobQueue(db);
  const id = await q.enqueue(makeParams());
  const job = await col.findOne({ _id: id });
  t.is(job!.attempts, 0);
  t.is(job!.max_attempts, 3);
});

test("inserted job has null last_error and completed_at", async (t) => {
  const q = new ExtractionJobQueue(db);
  const id = await q.enqueue(makeParams());
  const job = await col.findOne({ _id: id });
  t.is(job!.last_error, null);
  t.is(job!.completed_at, null);
});

test("inserted job persists all EnqueueParams fields", async (t) => {
  const q = new ExtractionJobQueue(db);
  const params = makeParams({
    userId: "user-42",
    sessionId: "sess-abc",
    turnId: "turn-xyz",
    userMessage: "What is AI?",
    assistantMessage: "It stands for artificial intelligence.",
    sidecarRaw: '{"turn_signal":"substantive"}',
    parseStatus: "parsed",
    scope: ["work", "research"],
    sourceModel: "openai:gpt-4o",
  });
  const id = await q.enqueue(params);
  const job = await col.findOne({ _id: id });
  t.is(job!.user_id, "user-42");
  t.is(job!.session_id, "sess-abc");
  t.is(job!.turn_id, "turn-xyz");
  t.is(job!.payload.user_message, "What is AI?");
  t.is(
    job!.payload.assistant_message,
    "It stands for artificial intelligence.",
  );
  t.is(job!.payload.sidecar, '{"turn_signal":"substantive"}');
  t.is(job!.payload.parse_status, "parsed");
  t.deepEqual(job!.payload.scope, ["work", "research"]);
  t.is(job!.payload.source_model, "openai:gpt-4o");
});

test("inserted job has created_at and updated_at set to the same Date", async (t) => {
  const q = new ExtractionJobQueue(db);
  const id = await q.enqueue(makeParams());
  const job = await col.findOne({ _id: id });
  t.truthy(job!.created_at);
  t.truthy(job!.updated_at);
  t.is(job!.created_at.toISOString(), job!.updated_at.toISOString());
});

test("enqueue works with null sidecarRaw", async (t) => {
  const q = new ExtractionJobQueue(db);
  const id = await q.enqueue(makeParams({ sidecarRaw: null }));
  const job = await col.findOne({ _id: id });
  t.is(job!.payload.sidecar, null);
});

test("multiple enqueues are all retrievable", async (t) => {
  const q = new ExtractionJobQueue(db);
  const ids = await Promise.all([
    q.enqueue(makeParams({ turnId: "t1" })),
    q.enqueue(makeParams({ turnId: "t2" })),
    q.enqueue(makeParams({ turnId: "t3" })),
  ]);
  t.is(await col.countDocuments({ _id: { $in: ids } }), 3);
});

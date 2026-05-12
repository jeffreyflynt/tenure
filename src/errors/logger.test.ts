import anyTest, { type TestFn } from "ava";
import sinon from "sinon";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection, type Db } from "mongodb";
import { ErrorLogger, type ErrorInput } from "./logger.js";
import type { ErrorLog } from "../types/error.js";
import type { Collections } from "../db/collections.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let errorCol: Collection<ErrorLog>;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  errorCol = db.collection<ErrorLog>("errors");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await errorCol.deleteMany({});
});

function makeCollections(overrides: Partial<Collections> = {}): Collections {
  return {
    errors: errorCol,
    beliefs: null as any,
    turns: null as any,
    sessions: null as any,
    jobs: null as any,
    config: null as any,
    topic_index: null as any,
    persona_cache: null as any,
    compaction_log: null as any,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ErrorInput> = {}): ErrorInput {
  return {
    severity: "error",
    stage: "provider_call",
    message: "Something went wrong",
    user_id: "user-1",
    ...overrides,
  };
}

test("log inserts a document into the errors collection", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const count = await errorCol.countDocuments();
  t.is(count, 1);
});

test("log persists severity, stage, and message verbatim", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(
    makeInput({
      severity: "critical",
      stage: "belief_write",
      message: "disk full",
    }),
  );
  const doc = await errorCol.findOne({});
  t.is(doc!.severity, "critical");
  t.is(doc!.stage, "belief_write");
  t.is(doc!.message, "disk full");
});

test("log persists user_id", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ user_id: "user-abc" }));
  const doc = await errorCol.findOne({});
  t.is(doc!.user_id, "user-abc");
});

test("log assigns a unique _id (UUID) to each document", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  await logger.log(makeInput());
  const docs = await errorCol.find({}).toArray();
  t.is(docs.length, 2);
  t.not(docs[0]._id, docs[1]._id);
  t.regex(docs[0]._id, /^[0-9a-f-]{36}$/i);
});

test("log sets occurred_at to a recent timestamp", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  const before = new Date();
  await logger.log(makeInput());
  const after = new Date();
  const doc = await errorCol.findOne({});
  t.true(doc!.occurred_at >= before && doc!.occurred_at <= after);
});

test("log defaults resolved to false", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.false(doc!.resolved);
});

test("log defaults resolved_at to null", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.resolved_at, null);
});

test("log persists session_id when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ session_id: "sess-1" }));
  const doc = await errorCol.findOne({});
  t.is(doc!.session_id, "sess-1");
});

test("log persists turn_id when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ turn_id: "turn-99" }));
  const doc = await errorCol.findOne({});
  t.is(doc!.turn_id, "turn-99");
});

test("log persists provider when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ provider: "anthropic" }));
  const doc = await errorCol.findOne({});
  t.is(doc!.provider, "anthropic");
});

test("log persists model when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ model: "claude-sonnet-4-20250514" }));
  const doc = await errorCol.findOne({});
  t.is(doc!.model, "claude-sonnet-4-20250514");
});

test("log persists context when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ context: { retries: 3, timeout: true } }));
  const doc = await errorCol.findOne({});
  t.deepEqual(doc!.context, { retries: 3, timeout: true });
});

test("log persists user_impacted=true when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ user_impacted: true }));
  const doc = await errorCol.findOne({});
  t.true(doc!.user_impacted);
});

test("log persists passthrough_succeeded when provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ passthrough_succeeded: true }));
  const doc = await errorCol.findOne({});
  t.true(doc!.passthrough_succeeded);
});

test("log extracts exception_type from Error object", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput({ error: new TypeError("bad input") }));
  const doc = await errorCol.findOne({});
  t.is(doc!.exception_type, "TypeError");
});

test("log extracts stack_trace from Error object", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  const err = new Error("boom");
  await logger.log(makeInput({ error: err }));
  const doc = await errorCol.findOne({});
  t.is(doc!.stack_trace, err.stack ?? null);
});

test("log defaults session_id to null when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.session_id, null);
});

test("log defaults turn_id to null when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.turn_id, null);
});

test("log defaults provider to null when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.provider, null);
});

test("log defaults model to null when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.model, null);
});

test("log defaults context to empty object when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.deepEqual(doc!.context, {});
});

test("log defaults user_impacted to false when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.false(doc!.user_impacted);
});

test("log defaults passthrough_succeeded to null when not provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.passthrough_succeeded, null);
});

test("log defaults exception_type to null when no error provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.exception_type, null);
});

test("log defaults stack_trace to null when no error provided", async (t) => {
  const logger = new ErrorLogger(makeCollections());
  await logger.log(makeInput());
  const doc = await errorCol.findOne({});
  t.is(doc!.stack_trace, null);
});

test("log does not throw when insertOne rejects", async (t) => {
  const failingCol = {
    insertOne: sinon.stub().rejects(new Error("mongo down")),
  } as unknown as Collection<ErrorLog>;

  const logger = new ErrorLogger(makeCollections({ errors: failingCol }));

  await t.notThrowsAsync(() => logger.log(makeInput()));
});

test("log writes to console.error when insertOne rejects", async (t) => {
  const consoleSpy = sinon.stub(console, "error");

  const failingCol = {
    insertOne: sinon.stub().rejects(new Error("mongo down")),
  } as unknown as Collection<ErrorLog>;

  const logger = new ErrorLogger(makeCollections({ errors: failingCol }));
  await logger.log(makeInput());

  t.true(consoleSpy.calledOnce);
  consoleSpy.restore();
});

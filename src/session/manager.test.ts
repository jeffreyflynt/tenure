import test from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { SessionManager, SessionNotBoundError } from "./manager.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await db.collection("sessions").deleteMany({});
});

test.serial("getOrCreate creates a new session", async (t) => {
  const mgr = new SessionManager(db);
  const session = await mgr.getOrCreate("sess-1", "user-1");
  t.is(session._id, "sess-1");
  t.is(session.userId, "user-1");
  t.is(session.providerId, null);
  t.is(session.model, null);
  t.deepEqual(session.activeScope, []);
  t.truthy(session.createdAt);
  t.truthy(session.lastUsedAt);
});

test.serial(
  "getOrCreate returns the same session on second call",
  async (t) => {
    const mgr = new SessionManager(db);
    const first = await mgr.getOrCreate("sess-2", "user-1");
    const second = await mgr.getOrCreate("sess-2", "user-1");
    t.is(second._id, first._id);
    t.is(second.userId, first.userId);
    t.is(second.createdAt.toISOString(), first.createdAt.toISOString());
  },
);

test.serial("getOrCreate updates lastUsedAt on second call", async (t) => {
  const mgr = new SessionManager(db);
  const first = await mgr.getOrCreate("sess-touch", "user-1");
  await new Promise((r) => setTimeout(r, 10));
  const second = await mgr.getOrCreate("sess-touch", "user-1");
  t.true(second.lastUsedAt >= first.lastUsedAt);
});

test.serial("getOrCreate scopes sessions by userId", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-user-a", "user-a");
  await mgr.getOrCreate("sess-user-b", "user-b");

  const fromA = await mgr.get("sess-user-a", "user-b");
  const fromB = await mgr.get("sess-user-b", "user-a");
  t.is(fromA, null);
  t.is(fromB, null);
});

test.serial("get returns null for a non-existent session", async (t) => {
  const mgr = new SessionManager(db);
  const result = await mgr.get("no-such-session", "user-1");
  t.is(result, null);
});

test.serial("get returns session after creation", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-get", "user-1");
  const result = await mgr.get("sess-get", "user-1");
  t.not(result, null);
  t.is(result!._id, "sess-get");
});

test.serial("get returns null when userId does not match", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-uid", "user-1");
  const result = await mgr.get("sess-uid", "user-wrong");
  t.is(result, null);
});

test.serial("update persists providerId and model", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-upd", "user-1");
  const updated = await mgr.update("sess-upd", "user-1", {
    providerId: "anthropic",
    model: "claude-3-5-sonnet",
  });
  t.is(updated!.providerId, "anthropic");
  t.is(updated!.model, "claude-3-5-sonnet");
});

test.serial("update persists activeScope", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-scope", "user-1");
  const updated = await mgr.update("sess-scope", "user-1", {
    activeScope: ["work", "coding"],
  });
  t.deepEqual(updated!.activeScope, ["work", "coding"]);
});

test.serial("update returns null for unknown session", async (t) => {
  const mgr = new SessionManager(db);
  const result = await mgr.update("ghost-session", "user-1", {
    model: "gpt-4",
  });
  t.is(result, null);
});

test.serial("update ignores undefined patch fields", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-partial", "user-1");
  await mgr.update("sess-partial", "user-1", { providerId: "openai" });
  const result = await mgr.update("sess-partial", "user-1", {
    model: "gpt-4o",
  });
  t.is(result!.providerId, "openai");
  t.is(result!.model, "gpt-4o");
});

test.serial(
  "touch updates lastUsedAt without changing other fields",
  async (t) => {
    const mgr = new SessionManager(db);
    await mgr.getOrCreate("sess-touch2", "user-1");
    await mgr.update("sess-touch2", "user-1", { model: "some-model" });
    await new Promise((r) => setTimeout(r, 10));
    await mgr.touch("sess-touch2", "user-1");
    const after = await mgr.get("sess-touch2", "user-1");
    t.is(after!.model, "some-model");
  },
);

test.serial(
  "requireBound throws SessionNotBoundError when providerId is null",
  async (t) => {
    const mgr = new SessionManager(db);
    await mgr.getOrCreate("sess-unbound", "user-1");
    await t.throwsAsync(() => mgr.requireBound("sess-unbound", "user-1"), {
      instanceOf: SessionNotBoundError,
    });
  },
);

test.serial(
  "requireBound throws when model is null even if providerId is set",
  async (t) => {
    const mgr = new SessionManager(db);
    await mgr.getOrCreate("sess-partial-bind", "user-1");
    await mgr.update("sess-partial-bind", "user-1", {
      providerId: "anthropic",
    });
    await t.throwsAsync(() => mgr.requireBound("sess-partial-bind", "user-1"), {
      instanceOf: SessionNotBoundError,
    });
  },
);

test.serial("requireBound returns session when fully bound", async (t) => {
  const mgr = new SessionManager(db);
  await mgr.getOrCreate("sess-bound", "user-1");
  await mgr.update("sess-bound", "user-1", {
    providerId: "anthropic",
    model: "claude-3-5-haiku",
  });
  const s = await mgr.requireBound("sess-bound", "user-1");
  t.is(s.providerId, "anthropic");
  t.is(s.model, "claude-3-5-haiku");
});

test.serial("SessionNotBoundError has correct name", (t) => {
  const err = new SessionNotBoundError("sess-123");
  t.is(err.name, "SessionNotBoundError");
  t.true(err.message.includes("sess-123"));
});

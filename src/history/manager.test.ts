import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection, type Db } from "mongodb";
import { HistoryManager, type AppendTurnInput, type Turn } from "./manager.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let col: Collection<Turn>;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  col = db.collection<Turn>("turns");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await col.deleteMany({});
});

let seq = 0;
function makeInput(overrides: Partial<AppendTurnInput> = {}): AppendTurnInput {
  seq++;
  return {
    sessionId: "session-1",
    userId: "user-1",
    turnId: `turn-${seq}`,
    userMessage: `User message ${seq}`,
    assistantMessage: `Assistant message ${seq}`,
    ...overrides,
  };
}

async function appendN(
  mgr: HistoryManager,
  n: number,
  overrides: Partial<AppendTurnInput> = {},
): Promise<Turn[]> {
  const turns: Turn[] = [];
  for (let i = 0; i < n; i++) {
    turns.push(await mgr.appendTurn(makeInput(overrides)));
  }
  return turns;
}

test("appendTurn inserts the document and returns it", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  const stored = await col.findOne({ _id: turn._id });
  t.truthy(stored);
  t.is(stored!._id, turn._id);
});

test("appendTurn assigns turnIndex=0 for the first turn", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  t.is(turn.turnIndex, 0);
});

test("appendTurn increments turnIndex for successive turns in the same session", async (t) => {
  const mgr = new HistoryManager(db);
  const turns = await appendN(mgr, 3);
  t.deepEqual(
    turns.map((t) => t.turnIndex),
    [0, 1, 2],
  );
});

test("turnIndex is independent per session", async (t) => {
  const mgr = new HistoryManager(db);
  const a = await mgr.appendTurn(makeInput({ sessionId: "sess-a" }));
  const b = await mgr.appendTurn(makeInput({ sessionId: "sess-b" }));
  t.is(a.turnIndex, 0);
  t.is(b.turnIndex, 0);
});

test("appendTurn defaults turnSignal to substantive", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  t.is(turn.turnSignal, "substantive");
});

test("appendTurn defaults boolean flags to false", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  t.false(turn.hasOpenQuestion);
  t.false(turn.hasNewBeliefs);
  t.false(turn.hasBinaryContent);
});

test("appendTurn defaults scope to empty array", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  t.deepEqual(turn.scope, []);
});

test("appendTurn persists explicit field values", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(
    makeInput({
      turnSignal: "acknowledgment",
      hasOpenQuestion: true,
      hasNewBeliefs: true,
      hasBinaryContent: true,
      scope: ["work", "coding"],
    }),
  );
  t.is(turn.turnSignal, "acknowledgment");
  t.true(turn.hasOpenQuestion);
  t.true(turn.hasNewBeliefs);
  t.true(turn.hasBinaryContent);
  t.deepEqual(turn.scope, ["work", "coding"]);
});

test("appendTurn sets createdAt", async (t) => {
  const mgr = new HistoryManager(db);
  const before = new Date();
  const turn = await mgr.appendTurn(makeInput());
  const after = new Date();
  t.true(turn.createdAt >= before && turn.createdAt <= after);
});

test("getRawWindow returns turns in ascending turnIndex order", async (t) => {
  const mgr = new HistoryManager(db);
  await appendN(mgr, 5);
  const window = await mgr.getRawWindow("session-1");
  const indices = window.map((t) => t.turnIndex);
  t.deepEqual(indices, [0, 1, 2, 3, 4]);
});

test("getRawWindow returns empty array for unknown session", async (t) => {
  const mgr = new HistoryManager(db);
  t.deepEqual(await mgr.getRawWindow("no-such-session"), []);
});

test("getRawWindow respects the limit parameter", async (t) => {
  const mgr = new HistoryManager(db);
  await appendN(mgr, 10);
  const window = await mgr.getRawWindow("session-1", 4);
  t.is(window.length, 4);
  t.deepEqual(
    window.map((t) => t.turnIndex),
    [6, 7, 8, 9],
  );
});

test("getRawWindow is scoped to sessionId", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(makeInput({ sessionId: "sess-x" }));
  await mgr.appendTurn(makeInput({ sessionId: "sess-y" }));
  const window = await mgr.getRawWindow("sess-x");
  t.true(window.every((t) => t.sessionId === "sess-x"));
});

test("getCompactedWindow returns empty array for unknown session", async (t) => {
  const mgr = new HistoryManager(db);
  t.deepEqual(await mgr.getCompactedWindow("no-such-session"), []);
});

test("getCompactedWindow always keeps the most recent alwaysKeepRecent turns", async (t) => {
  const mgr = new HistoryManager(db);
  await appendN(mgr, 5, {
    turnSignal: "acknowledgment",
    hasNewBeliefs: false,
    hasOpenQuestion: false,
  });
  const window = await mgr.getCompactedWindow("session-1", {
    alwaysKeepRecent: 2,
  });
  const indices = window.map((t) => t.turnIndex);
  t.true(indices.includes(3));
  t.true(indices.includes(4));
});

test("getCompactedWindow drops pure acknowledgments without new beliefs", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(
    makeInput({
      turnSignal: "acknowledgment",
      hasNewBeliefs: false,
      hasOpenQuestion: false,
    }),
  );
  await appendN(mgr, 2, { turnSignal: "substantive" });
  const window = await mgr.getCompactedWindow("session-1", {
    alwaysKeepRecent: 2,
  });
  t.true(window.every((t) => t.turnSignal !== "acknowledgment"));
});

test("getCompactedWindow keeps acknowledgments that have new beliefs", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(
    makeInput({
      turnSignal: "acknowledgment",
      hasNewBeliefs: true,
      hasOpenQuestion: false,
    }),
  );
  await appendN(mgr, 2, { turnSignal: "substantive" });
  const window = await mgr.getCompactedWindow("session-1", {
    alwaysKeepRecent: 2,
  });
  t.true(window.some((t) => t.turnSignal === "acknowledgment"));
});

test("getCompactedWindow keeps turns with open questions", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(
    makeInput({
      turnSignal: "acknowledgment",
      hasNewBeliefs: false,
      hasOpenQuestion: true,
    }),
  );
  await appendN(mgr, 2, { turnSignal: "substantive" });
  const window = await mgr.getCompactedWindow("session-1", {
    alwaysKeepRecent: 2,
  });
  t.true(window.some((t) => t.hasOpenQuestion === true));
});

test("getCompactedWindow respects maxTurns budget", async (t) => {
  const mgr = new HistoryManager(db);
  await appendN(mgr, 20);
  const window = await mgr.getCompactedWindow("session-1", { maxTurns: 5 });
  t.true(window.length <= 5);
});

test("getCompactedWindow returns turns in ascending order", async (t) => {
  const mgr = new HistoryManager(db);
  await appendN(mgr, 5);
  const window = await mgr.getCompactedWindow("session-1");
  const indices = window.map((t) => t.turnIndex);
  t.deepEqual(
    indices,
    [...indices].sort((a, b) => a - b),
  );
});

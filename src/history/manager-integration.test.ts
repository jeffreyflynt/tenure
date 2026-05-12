import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Collection, type Db } from "mongodb";
import { HistoryManager, type AppendTurnInput, type Turn } from "./manager.js";
import { EMPTY_RENDERED } from "./compaction.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let turns: Collection<Turn>;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  turns = db.collection<Turn>("turns");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    db.collection("turns").deleteMany({}),
    db.collection("jobs").deleteMany({}),
    db.collection("beliefs").deleteMany({}),
  ]);
});

let seq = 0;
function makeInput(overrides: Partial<AppendTurnInput> = {}): AppendTurnInput {
  seq++;
  return {
    sessionId: "session-1",
    userId: "user-1",
    turnId: `turn-${Date.now()}-${seq}`,
    userMessage: `User message ${seq}`,
    assistantMessage: `Assistant message ${seq}`,
    ...overrides,
  };
}

test("appendTurn inherits topicId from previous turn when omitted", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(makeInput({ topicId: "inherited-topic" }));
  const second = await mgr.appendTurn(makeInput());
  t.is(second.topicId, "inherited-topic");
});

test("appendTurn generates a UUID topicId when first in session and omitted", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput({ sessionId: "fresh-session" }));
  t.truthy(turn.topicId);
  t.regex(turn.topicId, /^[0-9a-f-]{36}$/i);
});

test("appendTurn topic inheritance is scoped to the session", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(makeInput({ sessionId: "sess-a", topicId: "topic-a" }));
  const turn = await mgr.appendTurn(makeInput({ sessionId: "sess-b" }));
  t.not(turn.topicId, "topic-a");
});

test("appendTurn promotes acknowledgment to substantive for long user messages", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(
    makeInput({
      turnSignal: "acknowledgment",
      userMessage: "a".repeat(400),
    }),
  );
  t.is(turn.turnSignal, "substantive");
});

test("appendTurn keeps acknowledgment for short user messages", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(
    makeInput({ turnSignal: "acknowledgment", userMessage: "Got it" }),
  );
  t.is(turn.turnSignal, "acknowledgment");
});

test("appendTurn promotion threshold is ~350 chars", async (t) => {
  const mgr = new HistoryManager(db);
  const below = await mgr.appendTurn(
    makeInput({ turnSignal: "acknowledgment", userMessage: "x".repeat(349) }),
  );
  const above = await mgr.appendTurn(
    makeInput({ turnSignal: "acknowledgment", userMessage: "x".repeat(351) }),
  );
  t.is(below.turnSignal, "acknowledgment");
  t.is(above.turnSignal, "substantive");
});

test("restoreTurn flips a collapsed turn to kept", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  await turns.updateOne(
    { _id: turn._id },
    { $set: { state: "collapsed", collapsedBy: "ack" } },
  );

  await mgr.restoreTurn(turn._id);

  const doc = await turns.findOne({ _id: turn._id });
  t.is(doc!.state, "kept");
});

test("restoreTurn sets userRestored to true", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  await turns.updateOne(
    { _id: turn._id },
    { $set: { state: "collapsed", collapsedBy: "budget_pressure" } },
  );

  await mgr.restoreTurn(turn._id);

  const doc = await turns.findOne({ _id: turn._id });
  t.true(doc!.userRestored);
});

test("restoreTurn clears collapsedBy", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());
  await turns.updateOne(
    { _id: turn._id },
    { $set: { state: "collapsed", collapsedBy: "dedup" } },
  );

  await mgr.restoreTurn(turn._id);

  const doc = await turns.findOne({ _id: turn._id });
  t.is(doc!.collapsedBy, null);
});

test("restoreTurn no-ops on an already-kept turn", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput());

  await mgr.restoreTurn(turn._id);

  const doc = await turns.findOne({ _id: turn._id });
  t.is(doc!.state, "kept");
  t.false(doc!.userRestored);
});

test("resolveOpenQuestion sets hasOpenQuestion to false", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput({ hasOpenQuestion: true }));

  await mgr.resolveOpenQuestion(turn._id);

  const doc = await turns.findOne({ _id: turn._id });
  t.false(doc!.hasOpenQuestion);
});

test("resolveOpenQuestion is safe on turns that already have it false", async (t) => {
  const mgr = new HistoryManager(db);
  const turn = await mgr.appendTurn(makeInput({ hasOpenQuestion: false }));

  await t.notThrowsAsync(() => mgr.resolveOpenQuestion(turn._id));
  const doc = await turns.findOne({ _id: turn._id });
  t.false(doc!.hasOpenQuestion);
});

test("renderCompacted returns EMPTY_RENDERED for an empty session", async (t) => {
  const mgr = new HistoryManager(db);
  const result = await mgr.renderCompacted("no-such-session");
  t.deepEqual(result, EMPTY_RENDERED);
});

test("renderCompacted renders all kept turns as user/assistant message pairs", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(
    makeInput({
      topicId: "t",
      turnSignal: "substantive",
      userMessage: "Hello",
      assistantMessage: "Hi there",
    }),
  );
  await mgr.appendTurn(
    makeInput({
      topicId: "t",
      turnSignal: "substantive",
      userMessage: "How are you?",
      assistantMessage: "Great!",
    }),
  );

  const result = await mgr.renderCompacted("session-1");

  t.is(result.turnsKept, 2);
  t.is(result.turnsCollapsed, 0);
  t.is(result.messages.length, 4);
  t.is(result.messages[0].content, "Hello");
  t.is(result.messages[1].content, "Hi there");
  t.is(result.messages[2].content, "How are you?");
  t.is(result.messages[3].content, "Great!");
});

test("renderCompacted collapses pure ack turns and persists to DB", async (t) => {
  const mgr = new HistoryManager(db);
  const ack = await mgr.appendTurn(makeInput({ turnSignal: "acknowledgment" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  const result = await mgr.renderCompacted("session-1");

  t.true(result.turnsCollapsed >= 1);

  const doc = await turns.findOne({ _id: ack._id });
  t.is(doc!.state, "collapsed");
  t.is(doc!.collapsedBy, "ack");

  const allContent = result.messages.map((m) => m.content).join(" ");
  t.false(allContent.includes(ack.userMessage));
});

test("renderCompacted backfills beliefCandidateIds from completed extraction jobs", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(
    makeInput({ turnSignal: "substantive", hasNewBeliefs: true }),
  );
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  await db.collection("jobs").insertOne({
    _id: "job-backfill",
    turn_id: target._id,
    status: "done",
    result_belief_ids: ["b-1", "b-2"],
  } as any);

  await db.collection("beliefs").insertMany([
    { _id: "b-1", type: "FACT", resolvedAt: null, supersededBy: null },
    { _id: "b-2", type: "FACT", resolvedAt: null, supersededBy: null },
  ] as any[]);

  await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: target._id });
  t.deepEqual(doc!.beliefCandidateIds, ["b-1", "b-2"]);
});

test("renderCompacted collapses dedup-eligible turns after backfill", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(
    makeInput({ turnSignal: "substantive", hasNewBeliefs: true }),
  );
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  await db.collection("jobs").insertOne({
    _id: "job-dedup",
    type: "extract_beliefs",
    turn_id: target._id,
    status: "done",
    result_belief_ids: ["b-active"],
  } as any);

  await db.collection("beliefs").insertOne({
    _id: "b-active",
    type: "entity",
    resolved_at: null,
    superseded_by: null,
  } as any);

  const result = await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: target._id });
  t.is(doc!.state, "collapsed");
  t.is(doc!.collapsedBy, "dedup");
  t.true(result.turnsCollapsed >= 1);
});

test("renderCompacted does not backfill from pending extraction jobs", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(makeInput({ hasNewBeliefs: true }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  await db.collection("jobs").insertOne({
    _id: "job-pending",
    type: "extract_beliefs",
    turn_id: target._id,
    status: "pending",
    result_belief_ids: ["b-never"],
  } as any);

  await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: target._id });
  t.deepEqual(doc!.beliefCandidateIds, []);
});

test("renderCompacted does not dedup when belief is superseded", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(
    makeInput({ turnSignal: "substantive", hasNewBeliefs: true }),
  );
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  await db.collection("jobs").insertOne({
    _id: "job-sup",
    type: "extract_beliefs",
    turn_id: target._id,
    status: "done",
    result_belief_ids: ["b-superseded"],
  } as any);

  await db.collection("beliefs").insertOne({
    _id: "b-superseded",
    type: "entity",
    resolved_at: null,
    superseded_by: "b-replacement",
  } as any);

  await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: target._id });
  t.is(doc!.state, "kept");
});

test("renderCompacted does not dedup when belief is a COMMITMENT", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(
    makeInput({ turnSignal: "substantive", hasNewBeliefs: true }),
  );
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  await db.collection("jobs").insertOne({
    _id: "job-commit",
    type: "extract_beliefs",
    turn_id: target._id,
    status: "done",
    result_belief_ids: ["b-commitment"],
  } as any);

  await db.collection("beliefs").insertOne({
    _id: "b-commitment",
    type: "decision",
    resolved_at: null,
    superseded_by: null,
  } as any);

  await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: target._id });
  t.is(doc!.state, "kept");
});

test("renderCompacted collapses turns from completed topics", async (t) => {
  const mgr = new HistoryManager(db);
  const old = await mgr.appendTurn(
    makeInput({ topicId: "topic-old", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-active", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-active", turnSignal: "substantive" }),
  );

  const result = await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: old._id });
  t.is(doc!.state, "collapsed");
  t.is(doc!.collapsedBy, "completed_topic");
  t.true(result.turnsCollapsed >= 1);
});

test("renderCompacted inserts a system-note marker for completed-topic collapses", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(
    makeInput({
      topicId: "topic-old",
      topics: ["billing"],
      turnSignal: "substantive",
    }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );

  const result = await mgr.renderCompacted("session-1");

  t.true(
    result.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("condensed"),
    ),
  );
});

test("renderCompacted collapses oldest unpinned turns when over token cap", async (t) => {
  const mgr = new HistoryManager(db);
  const allTurns: Turn[] = [];
  for (let i = 0; i < 5; i++) {
    allTurns.push(
      await mgr.appendTurn(
        makeInput({
          topicId: "same",
          turnSignal: "substantive",
          userMessage: "a".repeat(175),
          assistantMessage: "b".repeat(175),
        }),
      ),
    );
  }

  const result = await mgr.renderCompacted("session-1", 250);

  t.true(result.turnsCollapsed >= 2);
  t.true(result.tokensEstimated <= 250);

  const oldest = await turns.findOne({ _id: allTurns[0]._id });
  t.is(oldest!.state, "collapsed");
  t.is(oldest!.collapsedBy, "budget_pressure");

  const last = await turns.findOne({ _id: allTurns[4]._id });
  t.is(last!.state, "kept");
});

test("renderCompacted conservative mode applies ack but not completed_topic", async (t) => {
  const mgr = new HistoryManager(db);
  const ack = await mgr.appendTurn(makeInput({ turnSignal: "acknowledgment" }));
  const old = await mgr.appendTurn(
    makeInput({ topicId: "topic-old", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-active", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-active", turnSignal: "substantive" }),
  );

  await mgr.renderCompacted("session-1", 120000, {
    compactionMode: "conservative",
  });

  const ackDoc = await turns.findOne({ _id: ack._id });
  t.is(ackDoc!.state, "collapsed");
  t.is(ackDoc!.collapsedBy, "ack");

  const oldDoc = await turns.findOne({ _id: old._id });
  t.is(oldDoc!.state, "kept");
});

test("renderCompacted off mode returns raw history trimmed to token cap", async (t) => {
  const mgr = new HistoryManager(db);
  for (let i = 0; i < 5; i++) {
    await mgr.appendTurn(
      makeInput({
        userMessage: "a".repeat(175),
        assistantMessage: "b".repeat(175),
      }),
    );
  }

  const result = await mgr.renderCompacted("session-1", 250, {
    compactionMode: "off",
  });

  t.true(result.tokensEstimated <= 250);
  t.true(result.turnsKept < 5);
});

test("renderCompacted off mode does not persist any collapse decisions", async (t) => {
  const mgr = new HistoryManager(db);
  for (let i = 0; i < 5; i++) {
    await mgr.appendTurn(
      makeInput({
        userMessage: "a".repeat(175),
        assistantMessage: "b".repeat(175),
      }),
    );
  }

  await mgr.renderCompacted("session-1", 250, { compactionMode: "off" });

  const collapsed = await turns.find({ state: "collapsed" }).toArray();
  t.is(collapsed.length, 0);
});

test("renderCompacted is idempotent on second call", async (t) => {
  const mgr = new HistoryManager(db);
  await mgr.appendTurn(makeInput({ turnSignal: "acknowledgment" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  const first = await mgr.renderCompacted("session-1");
  const second = await mgr.renderCompacted("session-1");

  t.is(first.turnsKept, second.turnsKept);
  t.is(first.turnsCollapsed, second.turnsCollapsed);
  t.is(first.messages.length, second.messages.length);
});

test("idempotency: no additional DB writes on second call", async (t) => {
  const mgr = new HistoryManager(db);
  const ack = await mgr.appendTurn(makeInput({ turnSignal: "acknowledgment" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));
  await mgr.appendTurn(makeInput({ turnSignal: "substantive" }));

  await mgr.renderCompacted("session-1");
  const afterFirst = await turns.findOne({ _id: ack._id });
  t.is(afterFirst!.state, "collapsed");

  await mgr.renderCompacted("session-1");
  const afterSecond = await turns.findOne({ _id: ack._id });
  t.is(afterSecond!.state, "collapsed");
  t.is(afterSecond!.collapsedBy, "ack");
});

test("restored turn reappears in subsequent renderCompacted output", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(
    makeInput({
      topicId: "topic-old",
      turnSignal: "substantive",
      userMessage: "Restore me",
      assistantMessage: "I will be restored",
    }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );

  await mgr.renderCompacted("session-1");
  const collapsed = await turns.findOne({ _id: target._id });
  t.is(collapsed!.state, "collapsed");

  await mgr.restoreTurn(target._id);

  const result = await mgr.renderCompacted("session-1");
  const allContent = result.messages.map((m) => m.content).join(" ");
  t.true(allContent.includes("Restore me"));
  t.true(allContent.includes("I will be restored"));
});

test("restored completed-topic turn is not re-collapsed thanks to userRestored", async (t) => {
  const mgr = new HistoryManager(db);
  const target = await mgr.appendTurn(
    makeInput({ topicId: "topic-old", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );

  await mgr.renderCompacted("session-1");
  await mgr.restoreTurn(target._id);

  await mgr.renderCompacted("session-1");
  await mgr.renderCompacted("session-1");

  const doc = await turns.findOne({ _id: target._id });
  t.is(doc!.state, "kept");
  t.true(doc!.userRestored);
});

test("open question turn stays pinned until resolved", async (t) => {
  const mgr = new HistoryManager(db);
  const oq = await mgr.appendTurn(
    makeInput({
      topicId: "topic-old",
      turnSignal: "substantive",
      hasOpenQuestion: true,
    }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );
  await mgr.appendTurn(
    makeInput({ topicId: "topic-now", turnSignal: "substantive" }),
  );

  const before = await mgr.renderCompacted("session-1");
  const beforeContent = before.messages.map((m) => m.content).join(" ");
  t.true(beforeContent.includes(oq.userMessage));

  await mgr.resolveOpenQuestion(oq._id);
  await mgr.renderCompacted("session-1");

  const afterDoc = await turns.findOne({ _id: oq._id });
  t.is(afterDoc!.state, "collapsed");
  t.is(afterDoc!.collapsedBy, "completed_topic");
});

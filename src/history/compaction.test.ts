import anyTest, { type TestFn } from "ava";
import {
  estimateTokens,
  estimateTurnTokens,
  selectTrailingPinIds,
  isTurnPinned,
  evaluateRules,
  applyBudgetPressure,
  renderHistory,
  DEFAULT_COMPACTION_CONFIG,
  type CompactionConfig,
  type BeliefStatusMap,
} from "./compaction.js";
import type { Turn } from "./manager.js";

const test = anyTest.serial as TestFn;

let seq = 0;
function makeTurn(overrides: Partial<Turn> = {}): Turn {
  seq++;
  return {
    _id: `turn-${seq}`,
    sessionId: "session-1",
    userId: "user-1",
    turnIndex: seq - 1,
    topicId: "topic-1",
    topics: ["topic-1"],
    userMessage: `User ${seq}`,
    assistantMessage: `Assistant ${seq}`,
    tokenEstimate: 100,
    turnSignal: "substantive",
    beliefCandidateIds: [],
    hasOpenQuestion: false,
    hasNewBeliefs: false,
    hasBinaryContent: false,
    hasCodeBlock: false,
    scope: [],
    createdAt: new Date(),
    state: "kept",
    userRestored: false,
    collapsedBy: null,
    status: "complete",
    failureReason: null,
    ...overrides,
  };
}

const noBeliefs: BeliefStatusMap = {
  isActive: () => false,
  isCommitment: () => false,
};

const allActive: BeliefStatusMap = {
  isActive: () => true,
  isCommitment: () => false,
};

test("estimateTokens returns 0 for empty string", (t) => {
  t.is(estimateTokens(""), 0);
});

test("estimateTokens returns ceil(length / 3.5)", (t) => {
  t.is(estimateTokens("a".repeat(35)), 10);
  t.is(estimateTokens("a".repeat(4)), Math.ceil(4 / 3.5));
});

test("estimateTurnTokens sums user and assistant estimates", (t) => {
  const user = "a".repeat(35);
  const assistant = "b".repeat(70);
  t.is(estimateTurnTokens(user, assistant), 30);
});

test("estimateTurnTokens handles empty strings", (t) => {
  t.is(estimateTurnTokens("", ""), 0);
});

test("selectTrailingPinIds returns empty set for empty input", (t) => {
  t.is(selectTrailingPinIds([], 5).size, 0);
});

test("selectTrailingPinIds always pins the last turn", (t) => {
  const turns = [makeTurn(), makeTurn(), makeTurn()];
  const pins = selectTrailingPinIds(turns, 5);
  t.true(pins.has(turns[turns.length - 1]._id));
});

test("selectTrailingPinIds falls back to pinning second-to-last when lookback finds nothing substantive", (t) => {
  const turns = [
    makeTurn({
      turnSignal: "acknowledgment",
      hasNewBeliefs: false,
      hasOpenQuestion: false,
    }),
    makeTurn({
      turnSignal: "acknowledgment",
      hasNewBeliefs: false,
      hasOpenQuestion: false,
    }),
    makeTurn({
      turnSignal: "acknowledgment",
      hasNewBeliefs: false,
      hasOpenQuestion: false,
    }),
  ];
  const pins = selectTrailingPinIds(turns, 5);
  t.true(pins.has(turns[turns.length - 2]._id));
});

test("selectTrailingPinIds skips collapsed turns during lookback", (t) => {
  const substantive = makeTurn({ turnSignal: "substantive" });
  const collapsed = makeTurn({ turnSignal: "substantive", state: "collapsed" });
  const ack = makeTurn({
    turnSignal: "acknowledgment",
    hasNewBeliefs: false,
    hasOpenQuestion: false,
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([substantive, collapsed, ack, last], 5);
  t.true(pins.has(substantive._id));
});

test("selectTrailingPinIds pins a substantive turn found within lookback", (t) => {
  const substantive = makeTurn({ turnSignal: "substantive" });
  const ack = makeTurn({
    turnSignal: "acknowledgment",
    hasNewBeliefs: false,
    hasOpenQuestion: false,
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([substantive, ack, last], 5);
  t.true(pins.has(substantive._id));
});

test("selectTrailingPinIds pins a turn with hasNewBeliefs in lookback", (t) => {
  const withBeliefs = makeTurn({
    turnSignal: "acknowledgment",
    hasNewBeliefs: true,
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([withBeliefs, last], 5);
  t.true(pins.has(withBeliefs._id));
});

test("selectTrailingPinIds pins a turn with hasOpenQuestion in lookback", (t) => {
  const withQ = makeTurn({
    turnSignal: "acknowledgment",
    hasOpenQuestion: true,
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([withQ, last], 5);
  t.true(pins.has(withQ._id));
});

test("isTurnPinned returns true when id is in pin set", (t) => {
  const turn = makeTurn();
  t.true(isTurnPinned(turn, new Set([turn._id])));
});

test("isTurnPinned returns true for open question turns regardless of pin set", (t) => {
  const turn = makeTurn({ hasOpenQuestion: true });
  t.true(isTurnPinned(turn, new Set()));
});

test("isTurnPinned returns true for correction signal turns", (t) => {
  const turn = makeTurn({ turnSignal: "correction" });
  t.true(isTurnPinned(turn, new Set()));
});

test("isTurnPinned returns false for an ordinary turn not in pin set", (t) => {
  const turn = makeTurn();
  t.false(isTurnPinned(turn, new Set()));
});

test("evaluateRules collapses a pure acknowledgment turn", (t) => {
  const ack = makeTurn({
    turnSignal: "acknowledgment",
    beliefCandidateIds: [],
    hasOpenQuestion: false,
  });
  const buffer = makeTurn({ turnSignal: "substantive" });
  const last = makeTurn();
  const pins = selectTrailingPinIds([ack, buffer, last], 5);
  const decisions = evaluateRules(
    [ack, buffer, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.true(decisions.some((d) => d.turnId === ack._id && d.rule === "ack"));
});

test("evaluateRules does not collapse acknowledgment that has belief candidates", (t) => {
  const ack = makeTurn({
    turnSignal: "acknowledgment",
    beliefCandidateIds: ["b1"],
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([ack, last], 5);
  const decisions = evaluateRules(
    [ack, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.turnId === ack._id));
});

test("evaluateRules does not collapse acknowledgment with an open question", (t) => {
  const ack = makeTurn({ turnSignal: "acknowledgment", hasOpenQuestion: true });
  const last = makeTurn();
  const pins = selectTrailingPinIds([ack, last], 5);
  const decisions = evaluateRules(
    [ack, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.turnId === ack._id));
});

test("evaluateRules does not collapse already-collapsed turns", (t) => {
  const turn = makeTurn({ turnSignal: "acknowledgment", state: "collapsed" });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.turnId === turn._id));
});

test("evaluateRules does not collapse pinned turns", (t) => {
  const turn = makeTurn({ turnSignal: "acknowledgment" });
  const pins = new Set([turn._id]);
  const decisions = evaluateRules(
    [turn],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.is(decisions.length, 0);
});

test("evaluateRules applies dedup when all belief candidates are active and none is a commitment", (t) => {
  const turn = makeTurn({
    turnSignal: "substantive",
    beliefCandidateIds: ["b1"],
    hasOpenQuestion: false,
    userRestored: false,
  });
  const buffer = makeTurn({ turnSignal: "substantive" });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, buffer, last], 5);
  const decisions = evaluateRules(
    [turn, buffer, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    allActive,
  );
  t.true(decisions.some((d) => d.turnId === turn._id && d.rule === "dedup"));
});

test("evaluateRules does not apply dedup when a belief is a commitment", (t) => {
  const withCommitment: BeliefStatusMap = {
    isActive: () => true,
    isCommitment: (id) => id === "b1",
  };
  const turn = makeTurn({
    turnSignal: "substantive",
    beliefCandidateIds: ["b1"],
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    withCommitment,
  );
  t.false(decisions.some((d) => d.rule === "dedup"));
});

test("evaluateRules does not apply dedup when belief candidates are not all active", (t) => {
  const turn = makeTurn({
    turnSignal: "substantive",
    beliefCandidateIds: ["b1"],
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.rule === "dedup"));
});

test("evaluateRules does not apply dedup when userRestored is true", (t) => {
  const turn = makeTurn({
    turnSignal: "substantive",
    beliefCandidateIds: ["b1"],
    userRestored: true,
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    allActive,
  );
  t.false(decisions.some((d) => d.rule === "dedup"));
});

test("evaluateRules does not apply dedup in conservative mode", (t) => {
  const cfg: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    compactionMode: "conservative",
  };
  const turn = makeTurn({
    turnSignal: "substantive",
    beliefCandidateIds: ["b1"],
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    cfg,
    allActive,
  );
  t.false(decisions.some((d) => d.rule === "dedup"));
});

test("evaluateRules applies completed_topic for a turn on a different topic", (t) => {
  const old = makeTurn({
    topicId: "topic-old",
    turnSignal: "substantive",
    hasOpenQuestion: false,
    hasNewBeliefs: false,
    beliefCandidateIds: [],
  });
  const buffer = makeTurn({
    topicId: "topic-active",
    turnSignal: "substantive",
  });
  const last = makeTurn({ topicId: "topic-active" });
  const pins = selectTrailingPinIds([old, buffer, last], 5);
  const decisions = evaluateRules(
    [old, buffer, last],
    pins,
    "topic-active",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.true(
    decisions.some((d) => d.turnId === old._id && d.rule === "completed_topic"),
  );
});

test("evaluateRules does NOT apply completed_topic to a turn with no belief candidates", (t) => {
  const old = makeTurn({ topicId: "topic-old", turnSignal: "substantive" });
  const last = makeTurn({ topicId: "topic-active" });
  const pins = selectTrailingPinIds([old, last], 5);
  const decisions = evaluateRules(
    [old, last],
    pins,
    "topic-active",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.rule === "completed_topic"));
});

test("evaluateRules does not apply completed_topic to active topic turns", (t) => {
  const turn = makeTurn({ topicId: "topic-1" });
  const last = makeTurn({ topicId: "topic-1" });
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.rule === "completed_topic"));
});

test("evaluateRules does not apply completed_topic to correction turns", (t) => {
  const turn = makeTurn({ topicId: "topic-old", turnSignal: "correction" });
  const last = makeTurn({ topicId: "topic-active" });
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-active",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.rule === "completed_topic"));
});

test("evaluateRules does not apply completed_topic when turn has an open question", (t) => {
  const turn = makeTurn({ topicId: "topic-old", hasOpenQuestion: true });
  const last = makeTurn({ topicId: "topic-active" });
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-active",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.rule === "completed_topic"));
});

test("evaluateRules does not apply completed_topic when userRestored is true", (t) => {
  const turn = makeTurn({ topicId: "topic-old", userRestored: true });
  const last = makeTurn({ topicId: "topic-active" });
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-active",
    DEFAULT_COMPACTION_CONFIG,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.rule === "completed_topic"));
});

test("evaluateRules does not collapse ack with code block when compactCodeBlocks is false", (t) => {
  const cfg: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    compactCodeBlocks: false,
  };
  const turn = makeTurn({
    turnSignal: "acknowledgment",
    hasCodeBlock: true,
    beliefCandidateIds: [],
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    cfg,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.turnId === turn._id));
});

test("evaluateRules collapses ack with code block when compactCodeBlocks is true", (t) => {
  const cfg: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    compactCodeBlocks: true,
  };
  const turn = makeTurn({
    turnSignal: "acknowledgment",
    hasCodeBlock: true,
    beliefCandidateIds: [],
  });
  const buffer = makeTurn({ turnSignal: "substantive" });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, buffer, last], 5);
  const decisions = evaluateRules(
    [turn, buffer, last],
    pins,
    "topic-1",
    cfg,
    noBeliefs,
  );
  t.true(decisions.some((d) => d.turnId === turn._id && d.rule === "ack"));
});

test("evaluateRules does not collapse ack with binary content when compactCodeBlocks is false", (t) => {
  const cfg: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    compactCodeBlocks: false,
  };
  const turn = makeTurn({
    turnSignal: "acknowledgment",
    hasBinaryContent: true,
    beliefCandidateIds: [],
  });
  const last = makeTurn();
  const pins = selectTrailingPinIds([turn, last], 5);
  const decisions = evaluateRules(
    [turn, last],
    pins,
    "topic-1",
    cfg,
    noBeliefs,
  );
  t.false(decisions.some((d) => d.turnId === turn._id));
});

test("applyBudgetPressure returns empty array when total tokens are within cap", (t) => {
  const turns = [
    makeTurn({ tokenEstimate: 50 }),
    makeTurn({ tokenEstimate: 50 }),
  ];
  const pins = selectTrailingPinIds(turns, 5);
  t.deepEqual(
    applyBudgetPressure(turns, pins, 200, DEFAULT_COMPACTION_CONFIG),
    [],
  );
});

test("applyBudgetPressure returns empty array when exactly at cap", (t) => {
  const turns = [
    makeTurn({ tokenEstimate: 100 }),
    makeTurn({ tokenEstimate: 100 }),
  ];
  const pins = selectTrailingPinIds(turns, 5);
  t.deepEqual(
    applyBudgetPressure(turns, pins, 200, DEFAULT_COMPACTION_CONFIG),
    [],
  );
});

test("applyBudgetPressure collapses oldest unpinned turns first", (t) => {
  const turns = [
    makeTurn({ tokenEstimate: 100 }),
    makeTurn({ tokenEstimate: 100 }),
    makeTurn({ tokenEstimate: 100 }),
  ];
  const pins = new Set([turns[2]._id]);
  const decisions = applyBudgetPressure(
    turns,
    pins,
    150,
    DEFAULT_COMPACTION_CONFIG,
  );
  t.true(
    decisions.some(
      (d) => d.turnId === turns[0]._id && d.rule === "budget_pressure",
    ),
  );
});

test("applyBudgetPressure stops collapsing once under cap", (t) => {
  const turns = [
    makeTurn({ tokenEstimate: 100 }),
    makeTurn({ tokenEstimate: 100 }),
    makeTurn({ tokenEstimate: 100 }),
  ];
  const pins = new Set([turns[2]._id]);
  const decisions = applyBudgetPressure(
    turns,
    pins,
    150,
    DEFAULT_COMPACTION_CONFIG,
  );
  t.true(decisions.length <= 2);
});

test("applyBudgetPressure never collapses pinned turns", (t) => {
  const turns = [
    makeTurn({ tokenEstimate: 200 }),
    makeTurn({ tokenEstimate: 200 }),
  ];
  const pins = new Set(turns.map((t) => t._id));
  t.deepEqual(
    applyBudgetPressure(turns, pins, 50, DEFAULT_COMPACTION_CONFIG),
    [],
  );
});

test("applyBudgetPressure never collapses correction turns", (t) => {
  const correction = makeTurn({ tokenEstimate: 300, turnSignal: "correction" });
  const last = makeTurn({ tokenEstimate: 100 });
  const pins = new Set([last._id]);
  const decisions = applyBudgetPressure(
    [correction, last],
    pins,
    50,
    DEFAULT_COMPACTION_CONFIG,
  );
  t.false(decisions.some((d) => d.turnId === correction._id));
});

test("applyBudgetPressure skips already-collapsed turns", (t) => {
  const already = makeTurn({ tokenEstimate: 200, state: "collapsed" });
  const victim = makeTurn({ tokenEstimate: 200 });
  const last = makeTurn({ tokenEstimate: 200 });
  const pins = new Set([last._id]);
  const decisions = applyBudgetPressure(
    [already, victim, last],
    pins,
    250,
    DEFAULT_COMPACTION_CONFIG,
  );
  t.false(decisions.some((d) => d.turnId === already._id));
});

test("applyBudgetPressure respects compactCodeBlocks=false", (t) => {
  const cfg: CompactionConfig = {
    ...DEFAULT_COMPACTION_CONFIG,
    compactCodeBlocks: false,
  };
  const codeBlock = makeTurn({ tokenEstimate: 500, hasCodeBlock: true });
  const last = makeTurn({ tokenEstimate: 100 });
  const pins = new Set([last._id]);
  const decisions = applyBudgetPressure([codeBlock, last], pins, 50, cfg);
  t.false(decisions.some((d) => d.turnId === codeBlock._id));
});

test("renderHistory returns zero counts and empty messages for empty input", (t) => {
  const result = renderHistory([], new Set());
  t.deepEqual(result.messages, []);
  t.is(result.turnsKept, 0);
  t.is(result.turnsCollapsed, 0);
  t.is(result.tokensEstimated, 0);
});

test("renderHistory emits user then assistant messages for a pinned turn", (t) => {
  const turn = makeTurn({ userMessage: "hi", assistantMessage: "hello" });
  const result = renderHistory([turn], new Set([turn._id]));
  t.is(result.messages[0].role, "user");
  t.is(result.messages[0].content, "hi");
  t.is(result.messages[1].role, "assistant");
  t.is(result.messages[1].content, "hello");
});

test("renderHistory counts kept and collapsed turns independently", (t) => {
  const kept = makeTurn({ state: "kept" });
  const collapsed = makeTurn({
    state: "collapsed",
    collapsedBy: "completed_topic",
  });
  const last = makeTurn({ state: "kept" });
  const pins = new Set([kept._id, last._id]);
  const result = renderHistory([kept, collapsed, last], pins);
  t.is(result.turnsKept, 2);
  t.is(result.turnsCollapsed, 1);
});

test("renderHistory inserts a system note for completed_topic collapsed turns", (t) => {
  const collapsed = makeTurn({
    state: "collapsed",
    collapsedBy: "completed_topic",
    topicId: "old",
    topics: ["old"],
  });
  const last = makeTurn();
  const pins = new Set([last._id]);
  const result = renderHistory([collapsed, last], pins);
  t.true(
    result.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("condensed"),
    ),
  );
});

test("renderHistory does NOT insert a marker for ack-collapsed turns", (t) => {
  const ack = makeTurn({ state: "collapsed", collapsedBy: "ack" });
  const last = makeTurn();
  const pins = new Set([last._id]);
  const result = renderHistory([ack, last], pins);
  t.false(
    result.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("condensed"),
    ),
  );
});

test("renderHistory does NOT insert a marker for dedup-collapsed turns", (t) => {
  const dedup = makeTurn({ state: "collapsed", collapsedBy: "dedup" });
  const last = makeTurn();
  const pins = new Set([last._id]);
  const result = renderHistory([dedup, last], pins);
  t.false(
    result.messages.some(
      (m) => typeof m.content === "string" && m.content.includes("condensed"),
    ),
  );
});

test("renderHistory merges consecutive same-role messages", (t) => {
  const c1 = makeTurn({
    state: "collapsed",
    collapsedBy: "completed_topic",
    topicId: "old",
    topics: ["old"],
  });
  const c2 = makeTurn({
    state: "collapsed",
    collapsedBy: "completed_topic",
    topicId: "old",
    topics: ["old"],
  });
  const last = makeTurn();
  const pins = new Set([last._id]);
  const result = renderHistory([c1, c2, last], pins);
  for (let i = 1; i < result.messages.length; i++) {
    t.not(
      result.messages[i].role,
      result.messages[i - 1].role,
      `Adjacent same-role messages at indices ${i - 1} and ${i}`,
    );
  }
});

test("renderHistory accumulates tokensEstimated only for kept/pinned turns", (t) => {
  const kept = makeTurn({ state: "kept", tokenEstimate: 40 });
  const collapsed = makeTurn({ state: "collapsed", collapsedBy: "ack" });
  const last = makeTurn({ state: "kept", tokenEstimate: 60 });
  const pins = new Set([kept._id, last._id]);
  const result = renderHistory([kept, collapsed, last], pins);
  t.is(result.tokensEstimated, 100);
});

test("renderHistory system note includes topic label when topic is not 'default'", (t) => {
  const collapsed = makeTurn({
    state: "collapsed",
    collapsedBy: "completed_topic",
    topicId: "billing",
    topics: ["billing"],
  });
  const last = makeTurn();
  const pins = new Set([last._id]);
  const result = renderHistory([collapsed, last], pins);
  const marker = result.messages.find(
    (m) => typeof m.content === "string" && m.content.includes("condensed"),
  );
  t.truthy(marker);
  t.true((marker!.content as string).includes("billing"));
});

test("renderHistory system note omits label when topic is 'default'", (t) => {
  const collapsed = makeTurn({
    state: "collapsed",
    collapsedBy: "completed_topic",
    topicId: "default",
    topics: ["default"],
  });
  const last = makeTurn();
  const pins = new Set([last._id]);
  const result = renderHistory([collapsed, last], pins);
  const marker = result.messages.find(
    (m) => typeof m.content === "string" && m.content.includes("condensed"),
  );
  t.truthy(marker);
  t.false((marker!.content as string).includes('"default"'));
});

import type { Turn, CollapseRule } from "./manager.js";
import type { Message } from "../providers/types.js";

export interface CompactionConfig {
  compactionMode: "aggressive" | "conservative" | "off";
  compactCodeBlocks: boolean;
  trailingPinLookback: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  compactionMode: "aggressive",
  compactCodeBlocks: false,
  trailingPinLookback: 5,
};

export interface RenderedHistory {
  messages: Message[];
  tokensEstimated: number;
  turnsKept: number;
  turnsCollapsed: number;
}

export const EMPTY_RENDERED: RenderedHistory = {
  messages: [],
  tokensEstimated: 0,
  turnsKept: 0,
  turnsCollapsed: 0,
};

export interface BeliefStatusMap {
  isActive: (id: string) => boolean;
  isCommitment: (id: string) => boolean;
}

export interface CollapseDecision {
  turnId: string;
  rule: CollapseRule;
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3.5);
}

export function estimateTurnTokens(
  userMessage: string,
  assistantMessage: string,
): number {
  return estimateTokens(userMessage) + estimateTokens(assistantMessage);
}

export function selectTrailingPinIds(
  turns: Turn[],
  lookback: number,
): Set<string> {
  const pinIds = new Set<string>();
  if (turns.length === 0) return pinIds;

  pinIds.add(turns[turns.length - 1]._id);

  const searchStart = turns.length - 2;
  const searchEnd = Math.max(0, turns.length - 1 - lookback);

  for (let i = searchStart; i >= searchEnd; i--) {
    const t = turns[i];
    if (t.state === "collapsed") continue;
    if (
      t.turnSignal !== "acknowledgment" ||
      t.hasNewBeliefs ||
      t.hasOpenQuestion
    ) {
      pinIds.add(t._id);
      break;
    }
  }

  if (pinIds.size === 1 && turns.length >= 2) {
    pinIds.add(turns[turns.length - 2]._id);
  }

  return pinIds;
}

export function isTurnPinned(turn: Turn, trailingPinIds: Set<string>): boolean {
  return (
    trailingPinIds.has(turn._id) ||
    turn.hasOpenQuestion ||
    turn.turnSignal === "correction"
  );
}

function isContentProtected(turn: Turn, config: CompactionConfig): boolean {
  if (config.compactCodeBlocks) return false;
  return turn.hasBinaryContent || turn.hasCodeBlock;
}

export function evaluateRules(
  turns: Turn[],
  trailingPinIds: Set<string>,
  activeTopicId: string,
  config: CompactionConfig,
  beliefs: BeliefStatusMap,
): CollapseDecision[] {
  const decisions: CollapseDecision[] = [];

  for (const turn of turns) {
    if (turn.state === "collapsed") continue;
    if (isTurnPinned(turn, trailingPinIds)) continue;

    const rule = evaluateTurn(turn, activeTopicId, config, beliefs);
    if (rule) decisions.push({ turnId: turn._id, rule });
  }

  return decisions;
}

function evaluateTurn(
  turn: Turn,
  activeTopicId: string,
  config: CompactionConfig,
  beliefs: BeliefStatusMap,
): CollapseRule | null {
  if (checkAckRule(turn, config)) return "ack";

  if (config.compactionMode !== "aggressive") return null;

  if (checkDedupRule(turn, config, beliefs)) return "dedup";
  if (checkCompletedTopicRule(turn, config, activeTopicId, beliefs))
    return "completed_topic";

  return null;
}

function checkAckRule(turn: Turn, config: CompactionConfig): boolean {
  return (
    turn.turnSignal === "acknowledgment" &&
    turn.beliefCandidateIds.length === 0 &&
    !turn.hasOpenQuestion &&
    !turn.userRestored &&
    !isContentProtected(turn, config)
  );
}

function checkDedupRule(
  turn: Turn,
  config: CompactionConfig,
  beliefs: BeliefStatusMap,
): boolean {
  if (turn.beliefCandidateIds.length === 0) return false;
  if (!["substantive", "clarification"].includes(turn.turnSignal)) return false;
  if (turn.hasOpenQuestion) return false;
  if (turn.userRestored) return false;
  if (isContentProtected(turn, config)) return false;
  if (!turn.beliefCandidateIds.every((id) => beliefs.isActive(id)))
    return false;
  if (turn.beliefCandidateIds.some((id) => beliefs.isCommitment(id)))
    return false;
  return true;
}

function checkCompletedTopicRule(
  turn: Turn,
  config: CompactionConfig,
  activeTopicId: string,
  beliefs: BeliefStatusMap,
): boolean {
  if (turn.status !== "complete") return false;
  if (turn.topicId === activeTopicId) return false;
  if (turn.turnSignal === "correction") return false;
  if (turn.hasOpenQuestion) return false;
  if (turn.userRestored) return false;
  if (isContentProtected(turn, config)) return false;

  if (turn.hasNewBeliefs && turn.beliefCandidateIds.length === 0) return false;

  if (
    turn.beliefCandidateIds.length > 0 &&
    !turn.beliefCandidateIds.every((id) => beliefs.isActive(id))
  )
    return false;
  return true;
}

export function applyBudgetPressure(
  turns: Turn[],
  trailingPinIds: Set<string>,
  tokenCap: number,
  config: CompactionConfig,
): CollapseDecision[] {
  let totalTokens = 0;
  for (const t of turns) {
    if (t.state !== "collapsed") totalTokens += t.tokenEstimate;
  }
  if (totalTokens <= tokenCap) return [];

  const decisions: CollapseDecision[] = [];

  for (const turn of turns) {
    if (totalTokens <= tokenCap) break;
    if (turn.state === "collapsed") continue;
    if (isTurnPinned(turn, trailingPinIds)) continue;
    if (turn.turnSignal === "correction") continue;
    if (turn.userRestored) continue;
    if (
      !config.compactCodeBlocks &&
      (turn.hasBinaryContent || turn.hasCodeBlock)
    )
      continue;

    decisions.push({ turnId: turn._id, rule: "budget_pressure" });
    totalTokens -= turn.tokenEstimate;
  }

  return decisions;
}

export function renderHistory(
  turns: Turn[],
  trailingPinIds: Set<string>,
): RenderedHistory {
  const messages: Message[] = [];
  let pendingRun: {
    topicId: string;
    label: string;
    count: number;
  } | null = null;
  let turnsKept = 0;
  let turnsCollapsed = 0;
  let tokensEstimated = 0;

  function flushRun(): void {
    if (!pendingRun || pendingRun.count === 0) return;
    const noun = pendingRun.count === 1 ? "turn" : "turns";
    const marker =
      pendingRun.label && pendingRun.label !== "default"
        ? `[System note — "${pendingRun.label}": ${pendingRun.count} ${noun} condensed]`
        : `[System note — ${pendingRun.count} earlier ${noun} condensed]`;
    messages.push({ role: "assistant", content: marker });
    pendingRun = null;
  }

  for (const turn of turns) {
    const pinned = isTurnPinned(turn, trailingPinIds);

    if (pinned || turn.state === "kept") {
      flushRun();
      messages.push({ role: "user", content: turn.userMessage });
      messages.push({ role: "assistant", content: turn.assistantMessage });
      turnsKept++;
      tokensEstimated += turn.tokenEstimate;
      continue;
    }

    turnsCollapsed++;
    if (turn.collapsedBy === "ack" || turn.collapsedBy === "dedup") continue;

    const label = turn.topics[0] ?? "default";
    if (pendingRun && pendingRun.topicId === turn.topicId) {
      pendingRun.count++;
    } else {
      flushRun();
      pendingRun = { topicId: turn.topicId, label, count: 1 };
    }
  }

  flushRun();
  return {
    messages: mergeAdjacentRoles(messages),
    tokensEstimated,
    turnsKept,
    turnsCollapsed,
  };
}

function mergeAdjacentRoles(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;
  const result: Message[] = [{ ...messages[0] }];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    if (
      prev.role === curr.role &&
      typeof prev.content === "string" &&
      typeof curr.content === "string"
    ) {
      prev.content = `${prev.content}\n\n${curr.content}`;
    } else {
      result.push({ ...curr });
    }
  }

  return result;
}

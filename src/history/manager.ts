import { randomUUID } from "node:crypto";
import type { Collection, Db, Document } from "mongodb";
import {
  type CompactionConfig,
  type RenderedHistory,
  type BeliefStatusMap,
  type CollapseDecision,
  DEFAULT_COMPACTION_CONFIG,
  EMPTY_RENDERED,
  estimateTurnTokens,
  selectTrailingPinIds,
  evaluateRules,
  applyBudgetPressure,
  renderHistory,
} from "./compaction.js";
import type { Belief } from "../types/belief.js";

export type TurnSignal =
  | "substantive"
  | "acknowledgment"
  | "clarification"
  | "correction";

export type TurnState = "kept" | "collapsed";

export type TurnStatus = "complete" | "stream_failed" | "provider_failed";

export type CollapseRule =
  | "ack"
  | "dedup"
  | "completed_topic"
  | "budget_pressure";

export interface Turn {
  _id: string;
  sessionId: string;
  userId: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
  turnSignal: TurnSignal;
  hasOpenQuestion: boolean;
  hasNewBeliefs: boolean;
  hasBinaryContent: boolean;
  hasCodeBlock: boolean;
  scope: string[];
  createdAt: Date;
  state: TurnState;
  topicId: string;
  topics: string[];
  beliefCandidateIds: string[];
  userRestored: boolean;
  tokenEstimate: number;
  collapsedBy: CollapseRule | null;
  extractionStatus?: "done" | "failed";
  status: TurnStatus;
  failureReason: string | null;
}

export interface AppendTurnInput {
  sessionId: string;
  userId: string;
  turnId: string;
  userMessage: string;
  assistantMessage: string;
  hasBinaryContent?: boolean;
  hasCodeBlock?: boolean;
  turnSignal?: TurnSignal;
  hasOpenQuestion?: boolean;
  hasNewBeliefs?: boolean;
  scope?: string[];
  topicId?: string;
  topics?: string[];
  status?: TurnStatus;
  failureReason?: string | null;
}

const DEFAULT_TOKEN_CAP = 120000;

export class HistoryManager {
  private readonly col: Collection<Turn>;
  private readonly jobs: Collection<Document>;
  private readonly beliefs: Collection<Belief>;
  private readonly sessions: Collection<{
    _id: string;
    turnCounter?: number;
    lastUsedAt?: Date;
  }>;

  constructor(db: Db) {
    this.col = db.collection<Turn>("turns");
    this.jobs = db.collection("jobs");
    this.beliefs = db.collection<Belief>("beliefs");
    this.sessions = db.collection<{
      _id: string;
      turnCounter?: number;
      lastUsedAt?: Date;
    }>("sessions");
  }

  async appendTurn(input: AppendTurnInput): Promise<Turn> {
    const turnIndex = await this.allocateTurnIndex(
      input.sessionId,
      input.userId,
    );

    let topicId = input.topicId;
    if (!topicId) {
      const prev = await this.col.findOne<Pick<Turn, "topicId">>(
        { sessionId: input.sessionId },
        { sort: { turnIndex: -1 }, projection: { topicId: 1 } },
      );
      topicId = prev?.topicId ?? randomUUID();
    }

    let turnSignal = input.turnSignal ?? "substantive";
    if (
      turnSignal === "acknowledgment" &&
      estimateTurnTokens(input.userMessage, "") > 100
    ) {
      turnSignal = "substantive";
    }

    const doc: Turn = {
      _id: input.turnId,
      sessionId: input.sessionId,
      userId: input.userId,
      turnIndex,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      turnSignal,
      hasOpenQuestion: input.hasOpenQuestion ?? false,
      hasNewBeliefs: input.hasNewBeliefs ?? false,
      hasBinaryContent: input.hasBinaryContent ?? false,
      hasCodeBlock: input.hasCodeBlock ?? false,
      scope: input.scope ?? [],
      createdAt: new Date(),
      state: "kept",
      topicId,
      topics: input.topics ?? [],
      beliefCandidateIds: [],
      userRestored: false,
      tokenEstimate: estimateTurnTokens(
        input.userMessage,
        input.assistantMessage,
      ),
      collapsedBy: null,
      status: input.status ?? "complete",
      failureReason: input.failureReason ?? null,
    };

    await this.col.insertOne(doc);
    return doc;
  }

  private async allocateTurnIndex(
    sessionId: string,
    userId: string,
  ): Promise<number> {
    const res = await this.sessions.findOneAndUpdate(
      { _id: sessionId, userId },
      { $inc: { turnCounter: 1 }, $set: { lastUsedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (
      res &&
      typeof (res as { turnCounter?: number }).turnCounter === "number"
    ) {
      return (res as { turnCounter: number }).turnCounter - 1;
    }
    const last = await this.col
      .find({ sessionId })
      .sort({ turnIndex: -1 })
      .limit(1)
      .next();
    return last ? last.turnIndex + 1 : 0;
  }

  async renderCompacted(
    sessionId: string,
    tokenCap: number = DEFAULT_TOKEN_CAP,
    config: Partial<CompactionConfig> = {},
  ): Promise<RenderedHistory> {
    const cfg = { ...DEFAULT_COMPACTION_CONFIG, ...config };

    if (cfg.compactionMode === "off") {
      return this.renderRaw(sessionId, tokenCap);
    }

    await this.pickupCompletedExtractions(sessionId);

    const turns = await this.col
      .find({ sessionId, status: { $ne: "stream_failed" } })
      .sort({ turnIndex: 1 })
      .toArray();

    if (turns.length === 0) return EMPTY_RENDERED;

    this.applyLegacyDefaults(turns);

    const trailingPinIds = selectTrailingPinIds(turns, cfg.trailingPinLookback);
    const activeTopicId = turns[turns.length - 1].topicId;
    const beliefStatus = await this.buildBeliefStatusMap(turns);

    const ruleDecisions = evaluateRules(
      turns,
      trailingPinIds,
      activeTopicId,
      cfg,
      beliefStatus,
    );

    this.applyDecisionsInMemory(turns, ruleDecisions);

    const budgetDecisions = applyBudgetPressure(
      turns,
      trailingPinIds,
      tokenCap,
      cfg,
    );

    this.applyDecisionsInMemory(turns, budgetDecisions);

    const allDecisions = [...ruleDecisions, ...budgetDecisions];
    await this.persistCollapseDecisions(allDecisions);

    return renderHistory(turns, trailingPinIds);
  }

  async restoreTurn(turnId: string): Promise<void> {
    await this.col.updateOne(
      { _id: turnId, state: "collapsed" },
      {
        $set: {
          state: "kept" as TurnState,
          userRestored: true,
          collapsedBy: null,
        },
      },
    );
  }

  async resolveOpenQuestion(turnId: string): Promise<void> {
    await this.col.updateOne(
      { _id: turnId },
      { $set: { hasOpenQuestion: false } },
    );
  }

  async getCompactedWindow(
    sessionId: string,
    budget: Partial<{ maxTurns: number; alwaysKeepRecent: number }> = {},
  ): Promise<Turn[]> {
    const b = { maxTurns: 30, alwaysKeepRecent: 2, ...budget };
    const recent = (
      await this.col
        .find({ sessionId })
        .sort({ turnIndex: -1 })
        .limit(b.maxTurns)
        .toArray()
    ).reverse();

    if (recent.length === 0) return [];
    const keepFromIndex = Math.max(0, recent.length - b.alwaysKeepRecent);

    return recent.filter((turn, i) => {
      if (i >= keepFromIndex) return true;
      if (turn.hasOpenQuestion) return true;
      if (turn.hasBinaryContent || turn.hasCodeBlock) return true;
      if (turn.turnSignal === "acknowledgment" && !turn.hasNewBeliefs)
        return false;
      return true;
    });
  }

  async getRawWindow(sessionId: string, limit = 50): Promise<Turn[]> {
    return (
      await this.col
        .find({ sessionId })
        .sort({ turnIndex: -1 })
        .limit(limit)
        .toArray()
    ).reverse();
  }

  private async pickupCompletedExtractions(sessionId: string): Promise<void> {
    const pending = await this.col
      .find(
        {
          sessionId,
          status: "complete",
          hasNewBeliefs: true,
          beliefCandidateIds: { $size: 0 },
        },
        { projection: { _id: 1 } },
      )
      .toArray();

    if (pending.length === 0) return;

    const turnIds = pending.map((t) => t._id);
    const completed = await this.jobs
      .find({
        turn_id: { $in: turnIds },
        status: { $in: ["done", "failed"] },
      })
      .project<{
        _id: string;
        turn_id: string;
        status: "done" | "failed";
        result_belief_ids?: string[];
      }>({
        _id: 1,
        turn_id: 1,
        status: 1,
        result_belief_ids: 1,
      })
      .toArray();

    if (completed.length === 0) return;

    const ops = completed.map((j) => {
      const ids = Array.isArray(j.result_belief_ids) ? j.result_belief_ids : [];
      const hasResults = ids.length > 0;
      return {
        updateOne: {
          filter: { _id: j.turn_id },
          update: {
            $set: {
              beliefCandidateIds: ids,
              hasNewBeliefs: hasResults,
              extractionStatus: j.status,
            },
          },
        },
      };
    });

    await this.col.bulkWrite(ops);
  }

  private async buildBeliefStatusMap(turns: Turn[]): Promise<BeliefStatusMap> {
    const allIds = [...new Set(turns.flatMap((t) => t.beliefCandidateIds))];

    if (allIds.length === 0) {
      return { isActive: () => false, isCommitment: () => false };
    }

    const docs = await this.beliefs
      .find({ _id: { $in: allIds } })
      .project<{
        _id: string;
        type?: string;
        resolved_at?: Date | null;
        superseded_by?: string | null;
      }>({
        _id: 1,
        type: 1,
        resolved_at: 1,
        superseded_by: 1,
      })
      .toArray();

    const map = new Map(docs.map((b) => [b._id, b]));

    return {
      isActive: (id) => {
        const b = map.get(id);
        return b != null && b.resolved_at == null && b.superseded_by == null;
      },
      isCommitment: (id) => map.get(id)?.type === "decision",
    };
  }

  private applyLegacyDefaults(turns: Turn[]): void {
    for (const t of turns) {
      t.state ??= "kept";
      t.topicId ??= "default";
      t.topics ??= [];
      t.hasCodeBlock ??= false;
      t.beliefCandidateIds ??= [];
      t.userRestored ??= false;
      t.collapsedBy ??= null;
      t.tokenEstimate ??= estimateTurnTokens(t.userMessage, t.assistantMessage);
    }
  }

  private applyDecisionsInMemory(
    turns: Turn[],
    decisions: CollapseDecision[],
  ): void {
    const decisionMap = new Map(decisions.map((d) => [d.turnId, d.rule]));
    for (const t of turns) {
      const rule = decisionMap.get(t._id);
      if (rule) {
        t.state = "collapsed";
        t.collapsedBy = rule;
      }
    }
  }

  private async persistCollapseDecisions(
    decisions: CollapseDecision[],
  ): Promise<void> {
    if (decisions.length === 0) return;
    await this.col.bulkWrite(
      decisions.map((d) => ({
        updateOne: {
          filter: { _id: d.turnId, state: "kept" as const },
          update: {
            $set: {
              state: "collapsed" as TurnState,
              collapsedBy: d.rule,
            },
          },
        },
      })),
    );
  }

  private async renderRaw(
    sessionId: string,
    tokenCap: number,
  ): Promise<RenderedHistory> {
    const turns = await this.col
      .find({ sessionId })
      .sort({ turnIndex: 1 })
      .toArray();

    let tokensUsed = 0;
    let startIdx = turns.length;

    for (let i = turns.length - 1; i >= 0; i--) {
      const est =
        turns[i].tokenEstimate ??
        estimateTurnTokens(turns[i].userMessage, turns[i].assistantMessage);
      if (tokensUsed + est > tokenCap) break;
      tokensUsed += est;
      startIdx = i;
    }

    const kept = turns.slice(startIdx);
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

    for (const t of kept) {
      messages.push({ role: "user", content: t.userMessage });
      messages.push({ role: "assistant", content: t.assistantMessage });
    }

    return {
      messages,
      tokensEstimated: tokensUsed,
      turnsKept: kept.length,
      turnsCollapsed: turns.length - kept.length,
    };
  }
}

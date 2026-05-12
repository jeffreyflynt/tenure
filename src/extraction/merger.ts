import type { BeliefType, EpistemicStatus } from "../types/belief.js";
import { BeliefWriter, CanonicalNameConflictError } from "./beliefWriter.js";
import type {
  ExtractionResult,
  NewBelief,
  BeliefUpdateSignal,
  EntityUpdate,
  StyleSignal,
  AliasCandidate,
} from "./types.js";

export enum MergeAction {
  INSERTED = "inserted",
  REINFORCED = "reinforced",
  SUPERSEDED = "superseded",
  SKIPPED_LOW_CONFIDENCE = "skipped_low_confidence",
  FLAGGED_CONFLICT = "flagged_conflict",
  ALIAS_ADDED = "alias_added",
  CONTENT_EDITED = "content_edited",
  NOOP = "noop",
}

export interface MergePolicy {
  minInsertConfidence: number;
  conflictConfidenceMargin: number;
  maxAliasesPerBelief: number;
  inferredPromotionCount: number;
  /**
   * Minimum milliseconds between created_at and now before promotion is
   * allowed. Guards against a single long session driving a belief to active
   * through repeated reinforcement of the same causal chain.
   */
  inferredPromotionAgeMs: number;
}

const DEFAULT_POLICY: MergePolicy = {
  minInsertConfidence: 0.35,
  conflictConfidenceMargin: 0.15,
  maxAliasesPerBelief: 25,
  inferredPromotionCount: 5,
  inferredPromotionAgeMs: 48 * 60 * 60 * 1000,
};

export interface MergeDecision {
  action: MergeAction;
  beliefId: string | null;
  reason: string;
}

export interface MergeReport {
  decisions: MergeDecision[];
  aliasCandidatesDeferred: AliasCandidate[];
  styleSignalsDeferred: StyleSignal[];
  openQuestionsClosed: string[];
  newOpenQuestionIds: string[];
  errors: string[];
  turnSignal: string;
}

export interface MergeInput {
  userId: string;
  sessionId: string;
  turnId: string;
  sourceModel: string;
  result: ExtractionResult;
}

export class BeliefMerger {
  private readonly policy: MergePolicy;

  constructor(
    private readonly writer: BeliefWriter,
    policy: Partial<MergePolicy> = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  async merge(input: MergeInput): Promise<MergeReport> {
    const { userId, sessionId, turnId, sourceModel, result } = input;

    const report: MergeReport = {
      decisions: [],
      aliasCandidatesDeferred: [],
      styleSignalsDeferred: [],
      openQuestionsClosed: [],
      newOpenQuestionIds: [],
      errors: [],
      turnSignal: result.turn_signal,
    };

    for (const signal of result.belief_updates) {
      try {
        const decision = await this.applyBeliefUpdate(
          userId,
          sessionId,
          turnId,
          sourceModel,
          signal,
        );
        report.decisions.push(decision);
      } catch (e) {
        report.errors.push(
          `belief_update[${signal.belief_id}]: ${(e as Error).message}`,
        );
      }
    }

    for (const update of result.entity_updates) {
      try {
        await this.applyEntityUpdate(userId, update, report);
      } catch (e) {
        report.errors.push(
          `entity_update[${update.canonical_name}]: ${(e as Error).message}`,
        );
      }
    }

    for (const nb of result.new_beliefs) {
      try {
        const decision = await this.mergeOne(
          userId,
          sessionId,
          turnId,
          sourceModel,
          nb,
        );
        report.decisions.push(decision);

        if (
          nb.resolves_open_question &&
          decision.action === MergeAction.INSERTED &&
          !report.openQuestionsClosed.includes(nb.resolves_open_question)
        ) {
          try {
            const closed = await this.writer.closeOpenQuestion(
              userId,
              nb.resolves_open_question,
            );
            if (closed)
              report.openQuestionsClosed.push(nb.resolves_open_question);
          } catch (e) {
            report.errors.push(
              `auto_resolve[${nb.resolves_open_question}]: ${(e as Error).message}`,
            );
          }
        }
      } catch (e) {
        report.errors.push(
          `new_belief[${nb.canonical_name}]: ${(e as Error).message}`,
        );
      }
    }

    for (const q of result.new_open_questions) {
      try {
        const qid = await this.insertOpenQuestion(
          userId,
          sessionId,
          turnId,
          sourceModel,
          q.canonical_name,
          q.content,
          q.scope,
        );
        report.newOpenQuestionIds.push(qid);
      } catch (e) {
        report.errors.push(
          `new_open_question[${q.canonical_name}]: ${(e as Error).message}`,
        );
      }
    }

    for (const candidate of result.possible_alias_candidates) {
      report.aliasCandidatesDeferred.push(candidate);
    }

    for (const ss of result.style_signals) {
      report.styleSignalsDeferred.push(ss);
    }

    for (const qid of result.resolved_open_questions) {
      try {
        const closed = await this.writer.closeOpenQuestion(userId, qid);
        if (closed) report.openQuestionsClosed.push(qid);
      } catch (e) {
        report.errors.push(`resolve_question[${qid}]: ${(e as Error).message}`);
      }
    }

    return report;
  }

  private async mergeOne(
    userId: string,
    sessionId: string,
    turnId: string,
    sourceModel: string,
    nb: NewBelief,
  ): Promise<MergeDecision> {
    const matches = await this.writer.findByAliasOrCanonical(
      userId,
      nb.canonical_name,
    );
    const existing =
      matches.find(
        (m) => m.canonical_name === nb.canonical_name.trim().toLowerCase(),
      ) ??
      matches[0] ??
      null;

    if (existing === null) {
      if (nb.confidence < this.policy.minInsertConfidence && !nb.user_edited) {
        return {
          action: MergeAction.SKIPPED_LOW_CONFIDENCE,
          beliefId: null,
          reason: `confidence ${nb.confidence.toFixed(2)} < ${this.policy.minInsertConfidence}`,
        };
      }

      try {
        const beliefId = await this.insertBelief(
          userId,
          sessionId,
          turnId,
          sourceModel,
          nb,
        );
        return {
          action: MergeAction.INSERTED,
          beliefId,
          reason: "no matching belief found",
        };
      } catch (e) {
        if (e instanceof CanonicalNameConflictError) {
          const conflictMatch = await this.writer.findByCanonical(
            userId,
            nb.canonical_name,
            true,
          );
          if (!conflictMatch) {
            return {
              action: MergeAction.NOOP,
              beliefId: null,
              reason:
                "canonical name conflict but no active belief found on re-read",
            };
          }
          await this.writer.reinforce(
            userId,
            conflictMatch._id,
            sessionId,
            turnId,
          );
          await this.maybePromoteInferred(
            userId,
            conflictMatch._id,
            sessionId,
            turnId,
          );
          return {
            action: MergeAction.REINFORCED,
            beliefId: conflictMatch._id,
            reason: "canonical name conflict resolved as reinforcement",
          };
        }
        throw e;
      }
    }

    if (existing.content !== nb.content) {
      const margin = nb.confidence - existing.confidence;
      if (Math.abs(margin) < this.policy.conflictConfidenceMargin) {
        return {
          action: MergeAction.FLAGGED_CONFLICT,
          beliefId: existing._id,
          reason:
            "content differs within confidence margin; queued for user review",
        };
      }
      return {
        action: MergeAction.SKIPPED_LOW_CONFIDENCE,
        beliefId: existing._id,
        reason: `content differs; incoming margin ${margin >= 0 ? "+" : ""}${margin.toFixed(2)} insufficient without explicit supersede signal`,
      };
    }

    const newAliases = nb.aliases.filter(
      (a) =>
        !existing.aliases.includes(a.trim().toLowerCase()) &&
        a.trim().toLowerCase() !== existing.canonical_name,
    );

    if (
      newAliases.length > 0 &&
      existing.aliases.length + newAliases.length <=
        this.policy.maxAliasesPerBelief
    ) {
      await this.writer.addAliases(userId, existing._id, newAliases);
    }

    await this.writer.reinforce(userId, existing._id, sessionId, turnId);
    await this.maybePromoteInferred(userId, existing._id, sessionId, turnId);
    return {
      action: MergeAction.REINFORCED,
      beliefId: existing._id,
      reason: `matched existing; ${newAliases.length} alias(es) added`,
    };
  }

  /**
   * Promotes an inferred belief to active once it has accumulated enough
   * reinforcement across a sufficient span of time. Both conditions must be
   * met: the raw count guards against sparse signals, the age floor guards
   * against a single session driving a belief to active through repeated
   * reinforcement of the same causal chain.
   */
  private async maybePromoteInferred(
    userId: string,
    beliefId: string,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    const belief = await this.writer.get(userId, beliefId);
    if (!belief || belief.epistemic_status !== "inferred") return;

    const ageMs = Date.now() - belief.created_at.getTime();
    if (
      belief.reinforcement_count >= this.policy.inferredPromotionCount &&
      ageMs >= this.policy.inferredPromotionAgeMs
    ) {
      await this.writer.promoteToActive(userId, beliefId, sessionId, turnId);
    }
  }

  private async applyBeliefUpdate(
    userId: string,
    sessionId: string,
    turnId: string,
    sourceModel: string,
    signal: BeliefUpdateSignal,
  ): Promise<MergeDecision> {
    const target = await this.writer.get(userId, signal.belief_id);
    if (!target) {
      return {
        action: MergeAction.NOOP,
        beliefId: signal.belief_id,
        reason: "target belief not found",
      };
    }

    switch (signal.change) {
      case "reinforced":
        await this.writer.reinforce(userId, target._id, sessionId, turnId);
        return {
          action: MergeAction.REINFORCED,
          beliefId: target._id,
          reason: "explicit reinforcement signal",
        };

      case "contradicted":
        return {
          action: MergeAction.FLAGGED_CONFLICT,
          beliefId: target._id,
          reason: "explicit contradiction signal",
        };

      case "superseded": {
        await this.writer.supersede(userId, target._id, "", sessionId, turnId);

        const newContent = signal.new_content ?? target.content;
        const newCanonical = signal.new_canonical_name ?? target.canonical_name;

        const inheritedAliases = [
          ...new Set([...target.aliases, target.canonical_name]),
        ].filter((a) => a !== newCanonical);

        let replacementId: string;
        try {
          replacementId = await this.writer.create({
            user_id: userId,
            type: target.type,
            subtype: target.subtype,
            canonical_name: newCanonical,
            aliases: inheritedAliases,
            content: newContent,
            why_it_matters: target.why_it_matters,
            scope: [...target.scope],
            provenance: {
              session_id: sessionId,
              turn_id: turnId,
              extracted_at: new Date(),
              source_model: sourceModel,
            },
            epistemic_status: "active",
            confidence: target.confidence,
            pinned: target.pinned,
            user_edited: false,
            ...(target.expertise_domain !== undefined && {
              expertise_domain: target.expertise_domain,
            }),
            ...(target.expertise_depth !== undefined && {
              expertise_depth: target.expertise_depth,
            }),
            ...(target.expertise_evidence_count !== undefined && {
              expertise_evidence_count: target.expertise_evidence_count,
            }),
            change_log: [
              {
                changed_at: new Date(),
                trigger: `supersedes belief ${target._id}`,
                previous_content: target.content,
                previous_epistemic_status: target.epistemic_status,
                previous_confidence: target.confidence,
                changed_by_session: sessionId,
                changed_by_turn: turnId,
              },
            ],
          });
        } catch (e) {
          if (e instanceof CanonicalNameConflictError) {
            return {
              action: MergeAction.FLAGGED_CONFLICT,
              beliefId: target._id,
              reason:
                "supersede target canonical_name already active on another belief",
            };
          }
          throw e;
        }

        await this.writer.setSupersededBy(userId, target._id, replacementId);
        return {
          action: MergeAction.SUPERSEDED,
          beliefId: replacementId,
          reason: `superseded ${target._id}`,
        };
      }

      default:
        return {
          action: MergeAction.NOOP,
          beliefId: target._id,
          reason: `unknown change kind: ${signal.change}`,
        };
    }
  }

  private async applyEntityUpdate(
    userId: string,
    update: EntityUpdate,
    report: MergeReport,
  ): Promise<void> {
    const target = await this.writer.findByCanonical(
      userId,
      update.canonical_name,
    );
    if (!target) return;

    const newAliases = update.new_aliases.filter(
      (a) =>
        !target.aliases.includes(a.trim().toLowerCase()) &&
        a.trim().toLowerCase() !== target.canonical_name,
    );

    if (newAliases.length === 0) return;

    if (
      target.aliases.length + newAliases.length >
      this.policy.maxAliasesPerBelief
    ) {
      report.errors.push(`alias cap reached for ${target.canonical_name}`);
      return;
    }

    await this.writer.addAliases(userId, target._id, newAliases);
    report.decisions.push({
      action: MergeAction.ALIAS_ADDED,
      beliefId: target._id,
      reason: `added ${newAliases.length} alias(es) to ${target.canonical_name}`,
    });
  }

  private async insertBelief(
    userId: string,
    sessionId: string,
    turnId: string,
    sourceModel: string,
    nb: NewBelief,
  ): Promise<string> {
    return this.writer.create({
      user_id: userId,
      type: nb.type as BeliefType,
      subtype: nb.subtype ?? null,
      canonical_name: nb.canonical_name,
      aliases: nb.aliases,
      content: nb.content,
      why_it_matters: nb.why_it_matters,
      scope: nb.scope,
      provenance: {
        session_id: sessionId,
        turn_id: turnId,
        extracted_at: new Date(),
        source_model: sourceModel,
      },
      epistemic_status: nb.epistemic_status as EpistemicStatus,
      confidence: nb.confidence,
      pinned: false,
      user_edited: nb.user_edited,
      ...(nb.expertise_domain !== undefined && {
        expertise_domain: nb.expertise_domain,
      }),
      ...(nb.expertise_depth !== undefined && {
        expertise_depth: nb.expertise_depth,
      }),
      change_log: [
        {
          changed_at: new Date(),
          trigger: "initial extraction",
          changed_by_session: sessionId,
          changed_by_turn: turnId,
        },
      ],
    });
  }

  private async insertOpenQuestion(
    userId: string,
    sessionId: string,
    turnId: string,
    sourceModel: string,
    canonicalName: string,
    content: string,
    scope: string[],
  ): Promise<string> {
    return this.writer.create({
      user_id: userId,
      type: "open_question",
      subtype: null,
      canonical_name: canonicalName,
      aliases: [],
      content,
      why_it_matters: "",
      scope,
      provenance: {
        session_id: sessionId,
        turn_id: turnId,
        extracted_at: new Date(),
        source_model: sourceModel,
      },
      epistemic_status: "active",
      confidence: 0.7,
      pinned: false,
      user_edited: false,
      change_log: [
        {
          changed_at: new Date(),
          trigger: "open question extracted",
          changed_by_session: sessionId,
          changed_by_turn: turnId,
        },
      ],
    });
  }
}

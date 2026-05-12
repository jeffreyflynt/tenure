import { randomUUID } from "node:crypto";
import type { Collection, Filter } from "mongodb";
import type { Belief, ExpertiseDepth } from "../types/belief.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { PersonaCache } from "../context/personaCache.js";

const ACTIVE_FILTER = { resolved_at: null, superseded_by: null };

const DEDUP_COMPACTION_PROMPT =
  `You identify semantically duplicate beliefs and merge them into a single canonical belief.

You will receive a JSON array of belief objects. Return only a JSON object in this exact shape:
{ "merges": [...], "no_action_ids": [...] }

Each merge object:
{
  "keep_id": "<id of belief whose structure to base the merge on>",
  "retire_ids": ["<ids of beliefs being retired — never include keep_id here>"],
  "merged_content": "<most precise, complete expression of the shared fact>",
  "merged_canonical_name": "<snake_case>",
  "merged_aliases": ["<all aliases from all merged beliefs plus retired canonical names>"],
  "compaction_note": "<one sentence: what was merged and why>",
  "belief_type": "<type field copied from keep belief>"
}

Rules:
- Only merge when you are highly confident two beliefs express the same fact or preference.
- When uncertain, leave beliefs separate. Conservative is always correct here.
- merged_aliases must include the canonical names of all retired beliefs for search continuity.
- List every unmerged belief id in no_action_ids.
- Return valid JSON only. No prose outside the JSON object.`.trim();

const PREFERENCE_COMPACTION_PROMPT =
  `You identify semantically duplicate preference beliefs and merge them into a single canonical belief.
These beliefs shape how future LLM sessions interact with this user, so the merged result must be
maximally actionable — not just compact.

You will receive a JSON array of preference belief objects. Return only a JSON object:
{ "merges": [...], "no_action_ids": [...] }

Each merge object:
{
  "keep_id": "<id of the belief whose structure to base the merge on>",
  "retire_ids": ["<ids being retired — never include keep_id>"],
  "merged_content": "<the most complete, session-actionable characterization of this preference>",
  "merged_canonical_name": "<snake_case>",
  "merged_aliases": ["<all aliases from all merged beliefs plus retired canonical names>"],
  "compaction_note": "<one sentence: what was merged and why>",
  "belief_type": "preference"
}

Rules:
- Only merge beliefs that express the same underlying preference.
- merged_content must read as a direct instruction a model can act on immediately.
- Preserve nuance: if one belief adds a condition the other lacks, include it.
- merged_aliases must include all retired canonical_names for search continuity.
- List every unmerged belief id in no_action_ids.
- Return valid JSON only.`.trim();

const EXPERTISE_SYNTHESIS_PROMPT =
  `You analyze accumulated expertise signals for a user and produce structured assessments
per domain. Domains follow a hierarchical naming convention: "javascript" is a parent domain,
"javascript/react" and "javascript/bundlers" are subdomains. Assess each leaf domain
independently, then produce a rolled-up parent assessment only if the leaf assessments
collectively justify one.

You will receive a JSON array of expertise belief objects. Return only a JSON object:
{ "assessments": [...], "retire_ids": [...] }

Each assessment:
{
  "domain": "<e.g. 'postgres', 'javascript', 'javascript/react'>",
  "depth": "learning" | "working" | "deep" | "expert",
  "evidence_count": <number of source beliefs supporting this assessment>,
  "canonical_name": "<domain with slashes replaced by underscores>_expertise",
  "content": "<one sentence: what they know and at what depth>",
  "why_it_matters": "<what the model should assume or skip explaining for this domain>",
  "scope": ["user:universal"],
  "confidence": <0.0–1.0>
}

Depth calibration:
- learning:  actively building fundamentals; explain concepts, show reasoning
- working:   productive but not authoritative; skip basics, don't skip trade-offs
- deep:      corrects the model, sets conventions; treat as informed peer
- expert:    defines the field for themselves; defer on opinion, engage as equal

Subdomain handling:
- Assess each subdomain (e.g. javascript/react) independently based on its own signals.
- Produce a parent rollup (e.g. javascript) only when 2+ subdomains are assessed and their
  depths are consistent enough to generalize. A parent depth is the floor of its subdomains.
- Never invent a parent rollup from a single subdomain signal.

retire_ids: list every source belief id that is superseded by an assessment.
Return valid JSON only. No prose outside the JSON object.`.trim();

interface CompactionTypeConfig {
  threshold: number;
  cooldownMs: number;
  prompt: string;
  invalidatesPersona: boolean;
  isExpertiseSynthesis: boolean;
}

const TYPE_CONFIGS: Record<string, CompactionTypeConfig> = {
  preference: {
    threshold: 15,
    cooldownMs: 12 * 60 * 60 * 1000,
    prompt: PREFERENCE_COMPACTION_PROMPT,
    invalidatesPersona: true,
    isExpertiseSynthesis: false,
  },
  expertise: {
    threshold: 8,
    cooldownMs: 24 * 60 * 60 * 1000,
    prompt: EXPERTISE_SYNTHESIS_PROMPT,
    invalidatesPersona: true,
    isExpertiseSynthesis: true,
  },
  entity: {
    threshold: 25,
    cooldownMs: 24 * 60 * 60 * 1000,
    prompt: DEDUP_COMPACTION_PROMPT,
    invalidatesPersona: false,
    isExpertiseSynthesis: false,
  },
  decision: {
    threshold: 20,
    cooldownMs: 24 * 60 * 60 * 1000,
    prompt: DEDUP_COMPACTION_PROMPT,
    invalidatesPersona: false,
    isExpertiseSynthesis: false,
  },
};

/**
 * When two or more inferred beliefs are collapsed into one during compaction,
 * their combined reinforcement_count is checked against this threshold. If it
 * meets or exceeds it, the merged belief is written as active rather than
 * inferred. Two independently extracted inferred beliefs represent separate
 * extraction events, which is qualitatively stronger evidence than simple
 * reinforcement of a single belief, so the bar here is lower than the
 * merger's inferredPromotionCount.
 */
const INFERRED_PROMOTION_THRESHOLD = 3;

interface CompactionMerge {
  keep_id: string;
  retire_ids: string[];
  merged_content: string;
  merged_canonical_name: string;
  merged_aliases: string[];
  compaction_note: string;
  belief_type: string;
}

interface ExpertiseAssessment {
  domain: string;
  depth: ExpertiseDepth;
  evidence_count: number;
  canonical_name: string;
  content: string;
  why_it_matters: string;
  scope: string[];
  confidence: number;
}

export interface CompactionLogEntry {
  _id: string;
  user_id: string;
  scope: string;
  belief_type: string;
  ran_at: Date;
  merged_count: number;
}

export interface CompactionRunnerOptions {
  cooldownMs?: number;
}

export class BeliefCompactionRunner {
  constructor(
    private readonly beliefs: Collection<Belief>,
    private readonly compactionLog: Collection<CompactionLogEntry>,
    private readonly resolveAdapter: () => ProviderAdapter,
    private readonly modelId: string | null,
    private readonly personaCache: PersonaCache,
    private readonly personaSummary: {
      regenerate(userId: string): Promise<void>;
    },
    private readonly options: CompactionRunnerOptions = {},
  ) {}

  async run(userId: string): Promise<void> {
    for (const [beliefType, config] of Object.entries(TYPE_CONFIGS)) {
      const qualifyingScopes = await this.findQualifyingScopes(
        userId,
        beliefType,
        config,
      );
      for (const scope of qualifyingScopes) {
        await this.compact(userId, scope, beliefType, config).catch(
          (err: unknown) => {
            console.error(
              `[compaction] failed user=${userId} scope=${scope} type=${beliefType}:`,
              err,
            );
          },
        );
      }
    }
  }

  private async findQualifyingScopes(
    userId: string,
    beliefType: string,
    config: CompactionTypeConfig,
  ): Promise<string[]> {
    const typeFilter =
      beliefType === "expertise"
        ? { type: "preference", subtype: "expertise" }
        : {
            type: beliefType,
            $or: [{ subtype: null }, { subtype: { $exists: false } }],
          };

    const cooldownMs = this.options.cooldownMs ?? config.cooldownMs;

    const [countsByScope, recentRuns] = await Promise.all([
      this.beliefs
        .aggregate<{
          _id: string;
          count: number;
        }>([
          { $match: { user_id: userId, ...ACTIVE_FILTER, ...typeFilter } },
          { $unwind: "$scope" },
          { $group: { _id: "$scope", count: { $sum: 1 } } },
          { $match: { count: { $gte: config.threshold } } },
        ])
        .toArray(),
      this.compactionLog
        .find({
          user_id: userId,
          belief_type: beliefType,
          ran_at: { $gte: new Date(Date.now() - cooldownMs) },
        })
        .toArray(),
    ]);

    if (countsByScope.length === 0) return [];

    const recentScopes = new Set(recentRuns.map((r) => r.scope));
    return countsByScope.map((s) => s._id).filter((s) => !recentScopes.has(s));
  }

  private async compact(
    userId: string,
    scope: string,
    beliefType: string,
    config: CompactionTypeConfig,
  ): Promise<void> {
    const typeFilter =
      beliefType === "expertise"
        ? { type: "preference", subtype: "expertise" }
        : {
            type: beliefType,
            $or: [{ subtype: null }, { subtype: { $exists: false } }],
          };

    const scopeBeliefs = await this.beliefs
      .find({
        user_id: userId,
        scope: { $in: [scope] },
        ...ACTIVE_FILTER,
        ...typeFilter,
      } as Filter<Belief>)
      .toArray();

    if (scopeBeliefs.length < config.threshold) return;

    if (config.isExpertiseSynthesis) {
      await this.compactExpertise(userId, scope, scopeBeliefs, config);
    } else {
      await this.compactDedup(userId, scope, scopeBeliefs, config, beliefType);
    }
  }

  private async compactDedup(
    userId: string,
    scope: string,
    beliefs: Belief[],
    config: CompactionTypeConfig,
    beliefType: string,
  ): Promise<void> {
    const merges = await this.callDedupLLM(beliefs, config.prompt);
    await this.logRun(userId, scope, beliefType, merges.length);

    if (config.invalidatesPersona && scope === "user:universal") {
      await this.personaCache.invalidate(userId);
    }

    if (merges.length === 0) return;
    await this.applyDedupMerges(userId, merges);
  }

  private async callDedupLLM(
    beliefs: Belief[],
    prompt: string,
  ): Promise<CompactionMerge[]> {
    const payload = beliefs.map((b) => ({
      id: b._id,
      type: b.type,
      canonical_name: b.canonical_name,
      content: b.content,
      aliases: b.aliases,
      scope: b.scope,
    }));

    const resp = await this.resolveAdapter().call(
      {
        model: this.modelId ?? "",
        messages: [{ role: "user", content: JSON.stringify(payload) }],
        temperature: 0.1,
        max_tokens: 2000,
      },
      prompt,
    );

    const parsed = JSON.parse(this.extractJson(resp.content)) as {
      merges?: CompactionMerge[];
    };
    return Array.isArray(parsed.merges) ? parsed.merges : [];
  }

  private async applyDedupMerges(
    userId: string,
    merges: CompactionMerge[],
  ): Promise<void> {
    const now = new Date();

    for (const merge of merges) {
      const allIds = [merge.keep_id, ...merge.retire_ids];

      const mergeSources = await this.beliefs
        .find({ _id: { $in: allIds }, user_id: userId })
        .toArray();

      const source = mergeSources.find((b) => b._id === merge.keep_id);
      if (!source) continue;

      const totalReinforcements = mergeSources.reduce(
        (sum, b) => sum + (b.reinforcement_count ?? 0),
        0,
      );
      const maxLastReinforced = mergeSources.reduce(
        (max, b) => (b.last_reinforced_at > max ? b.last_reinforced_at : max),
        source.last_reinforced_at,
      );

      // Promote the merged belief to active if all contributing beliefs were
      // inferred and their combined reinforcement count crosses the threshold.
      // Two independently extracted inferred beliefs collapsing into one is
      // stronger evidence than simple reinforcement of a single belief, so the
      // promotion bar here is intentionally lower than the merger's threshold.
      const allInferred = mergeSources.every(
        (b) => b.epistemic_status === "inferred",
      );
      const promotedStatus =
        allInferred && totalReinforcements >= INFERRED_PROMOTION_THRESHOLD
          ? "active"
          : source.epistemic_status;

      const newId = randomUUID();
      const merged: Belief = {
        ...source,
        _id: newId,
        canonical_name: merge.merged_canonical_name,
        content: merge.merged_content,
        aliases: merge.merged_aliases,
        compaction_note: merge.compaction_note,
        epistemic_status: promotedStatus,
        reinforcement_count: totalReinforcements,
        last_reinforced_at: maxLastReinforced,
        superseded_by: null,
        created_at: now,
        updated_at: now,
        change_log: [
          {
            changed_at: now,
            trigger: `compaction: merged from ${allIds.join(", ")}${promotedStatus === "active" && allInferred ? "; promoted from inferred via combined reinforcement" : ""}`,
            changed_by_session: null,
            changed_by_turn: null,
          },
        ],
      };

      await this.beliefs.insertOne(merged);
      await this.beliefs.updateMany(
        { _id: { $in: allIds }, user_id: userId },
        {
          $set: {
            epistemic_status: "superseded",
            superseded_by: newId,
            updated_at: now,
          },
          $push: {
            change_log: {
              changed_at: now,
              trigger: `superseded by compaction: ${newId}`,
              changed_by_session: null,
              changed_by_turn: null,
            },
          },
        },
      );
    }
  }

  private async compactExpertise(
    userId: string,
    scope: string,
    beliefs: Belief[],
    _config: CompactionTypeConfig,
  ): Promise<void> {
    const { assessments, retireIds } = await this.callExpertiseLLM(beliefs);
    await this.logRun(userId, scope, "expertise", assessments.length);
    if (assessments.length === 0) return;

    await this.applyExpertiseAssessments(
      userId,
      assessments,
      retireIds,
      beliefs,
    );

    if (scope === "user:universal") {
      await this.personaSummary.regenerate(userId);
    }
  }
  private async callExpertiseLLM(beliefs: Belief[]): Promise<{
    assessments: ExpertiseAssessment[];
    retireIds: string[];
  }> {
    const payload = beliefs.map((b) => ({
      id: b._id,
      canonical_name: b.canonical_name,
      content: b.content,
      why_it_matters: b.why_it_matters,
      expertise_domain: b.expertise_domain ?? null,
      expertise_depth: b.expertise_depth ?? null,
      epistemic_status: b.epistemic_status,
      confidence: b.confidence,
      reinforcement_count: b.reinforcement_count,
      scope: b.scope,
    }));

    const resp = await this.resolveAdapter().call(
      {
        model: this.modelId ?? "",
        messages: [{ role: "user", content: JSON.stringify(payload) }],
        temperature: 0.1,
        max_tokens: 3000,
      },
      EXPERTISE_SYNTHESIS_PROMPT,
    );

    const parsed = JSON.parse(this.extractJson(resp.content)) as {
      assessments?: ExpertiseAssessment[];
      retire_ids?: string[];
    };

    return {
      assessments: Array.isArray(parsed.assessments) ? parsed.assessments : [],
      retireIds: Array.isArray(parsed.retire_ids) ? parsed.retire_ids : [],
    };
  }

  private async applyExpertiseAssessments(
    userId: string,
    assessments: ExpertiseAssessment[],
    retireIds: string[],
    sourceBeliefsForUser: Belief[],
  ): Promise<void> {
    const now = new Date();
    const sourceIds = sourceBeliefsForUser.map((b) => b._id);

    for (const assessment of assessments) {
      // Check if an active expertise belief already exists for this domain.
      // If so, supersede it so the assessment is always the current view.
      const existing = await this.beliefs.findOne({
        user_id: userId,
        subtype: "expertise",
        expertise_domain: assessment.domain,
        ...ACTIVE_FILTER,
      });

      const newId = randomUUID();

      const newBelief: Belief = {
        _id: newId,
        user_id: userId,
        type: "preference",
        subtype: "expertise",
        canonical_name: assessment.canonical_name,
        aliases: existing?.aliases ?? [],
        content: assessment.content,
        why_it_matters: assessment.why_it_matters,
        scope: assessment.scope,
        provenance: existing?.provenance ?? {
          session_id: "",
          turn_id: "",
          extracted_at: now,
          source_model: this.modelId ?? "unknown",
        },
        epistemic_status: "active",
        confidence: assessment.confidence,
        reinforcement_count: assessment.evidence_count,
        last_reinforced_at: now,
        pinned: false,
        user_edited: false,
        superseded_by: null,
        resolved_at: null,
        compaction_note: `Expertise synthesis across ${assessment.evidence_count} signal(s) for domain "${assessment.domain}"`,
        expertise_domain: assessment.domain,
        expertise_depth: assessment.depth,
        expertise_evidence_count: assessment.evidence_count,
        change_log: [
          {
            changed_at: now,
            trigger: existing
              ? `expertise re-synthesis superseding ${existing._id}`
              : `expertise synthesis from ${assessment.evidence_count} source belief(s)`,
            previous_content: existing?.content ?? null,
            previous_epistemic_status: existing?.epistemic_status ?? null,
            previous_confidence: existing?.confidence ?? null,
            changed_by_session: null,
            changed_by_turn: null,
          },
        ],
        created_at: now,
        updated_at: now,
      };

      await this.beliefs.insertOne(newBelief);

      if (existing) {
        await this.beliefs.updateOne(
          { _id: existing._id, user_id: userId },
          {
            $set: {
              epistemic_status: "superseded",
              superseded_by: newId,
              updated_at: now,
            },
            $push: {
              change_log: {
                changed_at: now,
                trigger: `superseded by expertise re-synthesis: ${newId}`,
                changed_by_session: null,
                changed_by_turn: null,
              },
            },
          },
        );
      }

      const toRetire = retireIds.filter((id) => sourceIds.includes(id));
      if (toRetire.length > 0) {
        await this.beliefs.updateMany(
          { _id: { $in: toRetire }, user_id: userId },
          {
            $set: {
              epistemic_status: "superseded",
              superseded_by: newId,
              updated_at: now,
            },
            $push: {
              change_log: {
                changed_at: now,
                trigger: `retired by expertise synthesis: ${newId}`,
                changed_by_session: null,
                changed_by_turn: null,
              },
            },
          },
        );
      }
    }
  }

  private async logRun(
    userId: string,
    scope: string,
    beliefType: string,
    mergedCount: number,
  ): Promise<void> {
    await this.compactionLog.insertOne({
      _id: randomUUID(),
      user_id: userId,
      scope,
      belief_type: beliefType,
      ran_at: new Date(),
      merged_count: mergedCount,
    });
  }

  private extractJson(raw: string): string {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .slice(0, 32_000);

    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : stripped;
  }
}

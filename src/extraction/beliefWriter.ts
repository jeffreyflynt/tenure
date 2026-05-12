import { randomUUID } from "node:crypto";
import type { Collection } from "mongodb";
import type {
  Belief,
  BeliefSubtype,
  BeliefType,
  ChangeLogEntry,
  EpistemicStatus,
  ExpertiseDepth,
} from "../types/belief.js";

export class CanonicalNameConflictError extends Error {
  constructor(
    public readonly userId: string,
    public readonly canonicalName: string,
  ) {
    super(
      `active belief already exists for user=${userId} canonical_name="${canonicalName}"`,
    );
  }
}

export interface CreateBeliefInput {
  user_id: string;
  type: BeliefType;
  subtype: BeliefSubtype;
  canonical_name: string;
  aliases: string[];
  content: string;
  why_it_matters: string;
  scope: string[];
  provenance: {
    session_id: string;
    turn_id: string;
    extracted_at: Date;
    source_model: string;
  };
  epistemic_status: EpistemicStatus;
  confidence: number;
  pinned: boolean;
  user_edited: boolean;
  change_log: ChangeLogEntry[];
  expertise_domain?: string;
  expertise_depth?: ExpertiseDepth;
  expertise_evidence_count?: number;
}

export class BeliefWriter {
  constructor(private readonly col: Collection<Belief>) {}

  async create(input: CreateBeliefInput): Promise<string> {
    const id = randomUUID();
    const now = new Date();

    const doc: Belief = {
      _id: id,
      user_id: input.user_id,
      type: input.type,
      subtype: input.subtype,
      canonical_name: input.canonical_name.trim().toLowerCase(),
      aliases: dedupeAliases(input.aliases),
      content: input.content,
      why_it_matters: input.why_it_matters,
      scope: input.scope,
      provenance: input.provenance,
      epistemic_status: input.epistemic_status,
      confidence: input.confidence,
      reinforcement_count: 0,
      last_reinforced_at: now,
      pinned: input.pinned,
      user_edited: input.user_edited,
      superseded_by: null,
      resolved_at: null,
      change_log: input.change_log,
      created_at: now,
      updated_at: now,
      ...(input.expertise_domain !== undefined && {
        expertise_domain: input.expertise_domain,
      }),
      ...(input.expertise_depth !== undefined && {
        expertise_depth: input.expertise_depth,
      }),
      ...(input.expertise_evidence_count !== undefined && {
        expertise_evidence_count: input.expertise_evidence_count,
      }),
    };

    try {
      await this.col.insertOne(doc);
      return id;
    } catch (e: any) {
      if (e.code === 11000) {
        throw new CanonicalNameConflictError(
          input.user_id,
          input.canonical_name,
        );
      }
      throw e;
    }
  }

  async get(userId: string, beliefId: string): Promise<Belief | null> {
    return await this.col.findOne({ _id: beliefId, user_id: userId });
  }

  async reinforce(
    userId: string,
    beliefId: string,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { _id: beliefId, user_id: userId },
      {
        $inc: { reinforcement_count: 1 },
        $set: { last_reinforced_at: now, updated_at: now },
        $push: {
          change_log: {
            changed_at: now,
            trigger: "reinforcement signal",
            changed_by_session: sessionId,
            changed_by_turn: turnId,
          },
        },
      },
    );
  }

  async addAliases(
    userId: string,
    beliefId: string,
    newAliases: string[],
  ): Promise<void> {
    const cleaned = newAliases
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    if (cleaned.length === 0) return;

    await this.col.updateOne(
      { _id: beliefId, user_id: userId },
      {
        $addToSet: { aliases: { $each: cleaned } },
        $set: { updated_at: new Date() },
      },
    );
  }

  async supersede(
    userId: string,
    oldId: string,
    newId: string,
    sessionId: string,
    turnId: string,
  ): Promise<void> {
    const now = new Date();
    await this.col.updateOne(
      { _id: oldId, user_id: userId },
      {
        $set: {
          superseded_by: newId,
          epistemic_status: "superseded" as EpistemicStatus,
          updated_at: now,
        },
        $push: {
          change_log: {
            changed_at: now,
            trigger: `superseded by belief ${newId}`,
            changed_by_session: sessionId,
            changed_by_turn: turnId,
          },
        },
      },
    );
  }

  async findByCanonical(
    userId: string,
    canonicalName: string,
    activeOnly = true,
  ): Promise<Belief | null> {
    const query: Record<string, unknown> = {
      user_id: userId,
      canonical_name: canonicalName.trim().toLowerCase(),
    };
    if (activeOnly) query.superseded_by = null;
    return await this.col.findOne(query);
  }

  async findByAliasOrCanonical(
    userId: string,
    surface: string,
    activeOnly = true,
  ): Promise<Belief[]> {
    const normalized = surface.trim().toLowerCase();
    const query: Record<string, unknown> = {
      user_id: userId,
      $or: [{ canonical_name: normalized }, { aliases: normalized }],
    };
    if (activeOnly) query.superseded_by = null;
    return await this.col.find(query).toArray();
  }

  async closeOpenQuestion(
    userId: string,
    questionId: string,
  ): Promise<boolean> {
    const now = new Date();
    const res = await this.col.updateOne(
      {
        _id: questionId,
        user_id: userId,
        type: "open_question",
        resolved_at: null,
      },
      {
        $set: { resolved_at: now, updated_at: now },
        $push: {
          change_log: { changed_at: now, trigger: "question resolved" },
        },
      },
    );
    return res.modifiedCount === 1;
  }

  /**
   * Promotes an inferred belief to active epistemic status. Called once
   * reinforcement_count and age thresholds are both satisfied. No-ops if the
   * belief is not currently inferred (guards against races).
   */
  async promoteToActive(
    userId: string,
    beliefId: string,
    sessionId: string,
    turnId: string,
  ): Promise<boolean> {
    const now = new Date();
    const res = await this.col.updateOne(
      { _id: beliefId, user_id: userId, epistemic_status: "inferred" },
      {
        $set: {
          epistemic_status: "active" as EpistemicStatus,
          updated_at: now,
        },
        $push: {
          change_log: {
            changed_at: now,
            trigger:
              "promoted from inferred to active via reinforcement threshold",
            changed_by_session: sessionId,
            changed_by_turn: turnId,
          },
        },
      },
    );
    return res.modifiedCount === 1;
  }

  async setSupersededBy(
    userId: string,
    oldId: string,
    newId: string,
  ): Promise<void> {
    await this.col.updateOne(
      { _id: oldId, user_id: userId },
      { $set: { superseded_by: newId } },
    );
  }
}

function dedupeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    const key = a.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

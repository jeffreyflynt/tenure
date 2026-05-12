import type { Collection } from "mongodb";
import type { Belief, BeliefType } from "../types/belief.js";

const ACTIVE_FILTER = { resolved_at: null, superseded_by: null };

export type ScoredBelief = Belief & {
  _searchScore: number;
  _scoreDetails?: Record<string, unknown>;
};

export interface SearchTextOptions {
  limit?: number;
  minScore?: number;
  scoreDetails?: boolean;
}

export class BeliefsReader {
  constructor(private readonly col: Collection<Belief>) {}

  async listAlwaysOn(
    userId: string,
    scope?: string[],
    limit = 40,
  ): Promise<Belief[]> {
    const filter: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      $or: [{ pinned: true }, { type: "preference" }],
    };
    if (scope?.length) filter.scope = { $in: scope };
    return this.col
      .find(filter)
      .sort({ pinned: -1, last_reinforced_at: -1 })
      .limit(limit)
      .toArray();
  }

  async listPinnedFacts(
    userId: string,
    scope?: string[],
    limit = 40,
    excludeIds: Set<string> = new Set(),
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      pinned: true,
      type: { $ne: "open_question" as const },
      scope: { $nin: ["universal", "user:universal"] },
    };

    if (excludeIds.size > 0) {
      base._id = { $nin: [...excludeIds] };
    }

    if (!scope?.length) {
      return this.col
        .find(base)
        .sort({ user_edited: -1, last_reinforced_at: -1 })
        .limit(limit)
        .toArray();
    }

    return this.col
      .find({
        ...base,
        $or: [{ user_edited: true }, { scope: { $in: scope } }],
      })
      .sort({ user_edited: -1, last_reinforced_at: -1 })
      .limit(limit)
      .toArray();
  }

  async listByScope(
    userId: string,
    scope: string[],
    types?: BeliefType[],
    limit = 40,
  ): Promise<Belief[]> {
    const filter: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      scope: { $in: scope },
    };
    if (types?.length) filter.type = { $in: types };
    return this.col.find(filter).limit(limit).toArray();
  }

  async searchText(
    userId: string,
    query: string,
    scope?: string[],
    opts: SearchTextOptions & { excludeIds?: Set<string> } = {},
  ): Promise<ScoredBelief[]> {
    const {
      limit = 20,
      minScore = 1.0,
      scoreDetails = false,
      excludeIds,
    } = opts;

    if (!query.trim()) return [];

    const fuzzyOpts = { maxEdits: 1, prefixLength: 2 };

    const searchStage: Record<string, unknown> = {
      index: "beliefs_search",
      compound: {
        must: [
          {
            compound: {
              should: [
                {
                  text: {
                    query,
                    path: "canonical_name",
                    fuzzy: fuzzyOpts,
                    score: { boost: { value: 14 } },
                  },
                },
                {
                  text: {
                    query,
                    path: { value: "canonical_name", multi: "phrase" },
                    score: { boost: { value: 14 } },
                  },
                },
                {
                  text: {
                    query,
                    path: "aliases",
                    fuzzy: fuzzyOpts,
                    score: { boost: { value: 5 } },
                  },
                },
                {
                  text: {
                    query,
                    path: { value: "aliases", multi: "shingle" },
                    score: { boost: { value: 14 } },
                  },
                },
              ],
              minimumShouldMatch: 1,
            },
          },
        ],
        filter: [
          { equals: { path: "user_id", value: userId } },
          { equals: { path: "resolved_at", value: null } },
          { equals: { path: "superseded_by", value: null } },
        ],
        mustNot: [
          { equals: { path: "type", value: "open_question" } },
          { equals: { path: "subtype", value: "expertise" } },
        ],
      },
    };
    if (scoreDetails) searchStage.scoreDetails = true;

    const addFields: Record<string, unknown> = {
      _searchScore: { $meta: "searchScore" },
    };
    if (scoreDetails) addFields._scoreDetails = { $meta: "searchScoreDetails" };

    const matchStage: Record<string, unknown> = {
      ...(scope?.length ? { scope: { $in: scope } } : {}),
    };

    if (excludeIds?.size) {
      matchStage._id = { $nin: [...excludeIds] };
    }

    const pipeline: object[] = [
      { $search: searchStage },
      { $match: matchStage },
      { $addFields: addFields },
      { $match: { _searchScore: { $gte: minScore } } },
      { $limit: limit },
    ];

    return this.col.aggregate<ScoredBelief>(pipeline).toArray();
  }

  async listPinnedOpenQuestions(
    userId: string,
    scope?: string[],
    limit = 15,
  ): Promise<Belief[]> {
    const filter: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      type: "open_question",
      pinned: true,
    };
    if (scope?.length) filter.scope = { $in: scope };
    return this.col.find(filter).limit(limit).toArray();
  }

  async countActive(userId: string): Promise<number> {
    return this.col.countDocuments({ user_id: userId, ...ACTIVE_FILTER });
  }
}

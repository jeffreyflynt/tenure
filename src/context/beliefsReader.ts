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
  excludeIds?: Set<string>;
  agentId?: string | null;
}

export class BeliefsReader {
  constructor(private readonly col: Collection<Belief>) {}

  /**
   * Merges an agent filter with an existing $or clause without clobbering.
   * MongoDB does not allow multiple $or at the top level of a single filter
   * object, so when the base query already uses $or we wrap both in $and.
   */
  private mergeFilter(
    base: Record<string, unknown>,
    agentId: string | null | undefined,
  ): Record<string, unknown> {
    if (!agentId) return base;

    const agentOr = [{ agent_id: agentId }, { agent_id: null }];

    if (base.$or) {
      const existingOr = base.$or;
      const { $or: _, ...rest } = base;
      return {
        ...rest,
        $and: [{ $or: existingOr }, { $or: agentOr }],
      };
    }

    return { ...base, $or: agentOr };
  }

  async listAlwaysOn(
    userId: string,
    scope?: string[],
    limit = 40,
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      $or: [{ pinned: true }, { type: "preference" }],
    };
    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, agentId);

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
    agentId?: string | null,
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

    if (scope?.length) {
      base.scope = { $in: scope };
    }

    const filter = this.mergeFilter(base, agentId);

    return this.col
      .find(filter)
      .sort({ user_edited: -1, last_reinforced_at: -1 })
      .limit(limit)
      .toArray();
  }

  async listByScope(
    userId: string,
    scope: string[],
    types?: BeliefType[],
    limit = 40,
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      scope: { $in: scope },
    };
    if (types?.length) base.type = { $in: types };

    const filter = this.mergeFilter(base, agentId);

    return this.col.find(filter).limit(limit).toArray();
  }

  async searchText(
    userId: string,
    query: string,
    scope?: string[],
    opts: SearchTextOptions = {},
  ): Promise<ScoredBelief[]> {
    const {
      limit = 20,
      minScore = 1.0,
      scoreDetails = false,
      excludeIds,
      agentId,
    } = opts;

    if (!query.trim()) return [];

    const fuzzyOpts = { maxEdits: 1, prefixLength: 2 };

    const filterClauses: Record<string, unknown>[] = [
      { equals: { path: "user_id", value: userId } },
      { equals: { path: "resolved_at", value: null } },
      { equals: { path: "superseded_by", value: null } },
    ];

    if (scope?.length) {
      filterClauses.push({
        in: { path: "scope", value: scope },
      });
    }

    // Agent isolation: beliefs must belong to this agent or the shared pool.
    // Uses a compound should with minimumShouldMatch:1 to express OR within
    // the Atlas Search filter context (which does not support top-level $or).
    if (agentId) {
      filterClauses.push({
        compound: {
          should: [
            { equals: { path: "agent_id", value: agentId } },
            { equals: { path: "agent_id", value: null } },
          ],
          minimumShouldMatch: 1,
        },
      });
    }

    const mustNotClauses: Record<string, unknown>[] = [
      { equals: { path: "type", value: "open_question" } },
      { equals: { path: "subtype", value: "expertise" } },
    ];

    if (excludeIds?.size) {
      for (const id of excludeIds) {
        mustNotClauses.push({ equals: { path: "_id", value: id } });
      }
    }

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
        filter: filterClauses,
        mustNot: mustNotClauses,
      },
    };
    if (scoreDetails) searchStage.scoreDetails = true;

    const addFields: Record<string, unknown> = {
      _searchScore: { $meta: "searchScore" },
    };
    if (scoreDetails) addFields._scoreDetails = { $meta: "searchScoreDetails" };

    const pipeline: object[] = [
      { $search: searchStage },
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
    agentId?: string | null,
  ): Promise<Belief[]> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
      type: "open_question",
      pinned: true,
    };
    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, agentId);

    return this.col.find(filter).limit(limit).toArray();
  }

  async findByCanonicalNames(
    userId: string,
    names: string[],
    scope?: string[],
    opts: { agentId?: string | null; excludeIds?: Set<string> } = {},
  ): Promise<Belief[]> {
    if (names.length === 0) return [];

    const base: Record<string, unknown> = {
      user_id: userId,
      canonical_name: { $in: names.map((n) => n.trim().toLowerCase()) },
      ...ACTIVE_FILTER,
    };

    if (scope?.length) base.scope = { $in: scope };

    const filter = this.mergeFilter(base, opts.agentId);

    const results = await this.col.find(filter).toArray();

    if (opts.excludeIds?.size) {
      return results.filter((b) => !opts.excludeIds!.has(b._id));
    }

    return results;
  }

  async countActive(userId: string, agentId?: string | null): Promise<number> {
    const base: Record<string, unknown> = {
      user_id: userId,
      ...ACTIVE_FILTER,
    };

    const filter = this.mergeFilter(base, agentId);

    return this.col.countDocuments(filter);
  }
}

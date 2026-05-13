import type { BeliefsReader } from "./beliefsReader.js";
import type { ScoredBelief } from "./beliefsReader.js";
import type { Belief } from "../types/belief.js";
import { buildSearchQuery } from "./queryExpander.js";

export type ProjectionMode = "rich" | "lean";

export interface ContextBudget {
  maxBeliefs: number;
  maxPinnedFacts: number;
  maxQuestions: number;
  maxCharsPerBelief: number;
  maxPersonaChars: number;
  maxScopePreludeChars: number;
  projection: ProjectionMode;
  scoreDetails: boolean;
}

const DEFAULT_BUDGET: ContextBudget = {
  maxBeliefs: 20,
  maxPinnedFacts: 10,
  maxQuestions: 15,
  maxCharsPerBelief: 400,
  maxPersonaChars: 800,
  maxScopePreludeChars: 400,
  projection: "lean",
  scoreDetails: false,
};

export interface BeliefScore {
  id: string;
  score: number;
  scoreDetails?: unknown;
}

export interface BuiltContext {
  personaPrelude: string;
  pinnedFactsJson: string;
  expandedQuery: string;
  queryWasNoisy: boolean;
  relevantBeliefsJson: string;
  openQuestionsJson: string;
  beliefCount: number;
  questionCount: number;
  truncated: boolean;
  searchScores: BeliefScore[];
}

export interface PersonaLookup {
  get(userId: string): Promise<{
    universal?: string;
    per_scope?: Record<string, string>;
  } | null>;
}

export class ContextBuilder {
  private readonly budget: ContextBudget;

  constructor(
    private readonly reader: BeliefsReader,
    private readonly persona: PersonaLookup,
    budget: Partial<ContextBudget> = {},
  ) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
  }

  async build(
    userId: string,
    scope: string[],
    query: string,
  ): Promise<BuiltContext> {
    const { query: expandedQuery, wasNoisy: queryWasNoisy } =
      buildSearchQuery(query);

    const [personaDoc, pinnedFacts, questions] = await Promise.all([
      this.persona.get(userId),
      this.reader.listPinnedFacts(userId, scope, this.budget.maxPinnedFacts),
      this.reader.listPinnedOpenQuestions(
        userId,
        scope,
        this.budget.maxQuestions,
      ),
    ]);

    const pinnedIds = new Set(pinnedFacts.map((b) => b._id));

    const rawSearchResults = expandedQuery
      ? await this.reader.searchText(userId, expandedQuery, scope, {
          limit: this.budget.maxBeliefs,
          minScore: 3,
          scoreDetails: this.budget.scoreDetails,
          excludeIds: pinnedIds,
        })
      : ([] as ScoredBelief[]);

    const searchScores: BeliefScore[] = rawSearchResults.map((b) => ({
      id: b._id as string,
      score: b._searchScore,
      ...(b._scoreDetails != null ? { scoreDetails: b._scoreDetails } : {}),
    }));

    const personaPrelude = this.clip(
      personaDoc?.universal ?? "",
      this.budget.maxPersonaChars,
    );

    const combined = [...pinnedFacts, ...rawSearchResults];
    const cap = this.budget.maxBeliefs;
    const truncated = combined.length > cap;
    const capped = combined.slice(0, cap);

    const cappedPinned = capped.slice(0, Math.min(pinnedFacts.length, cap));
    const cappedRelevant = capped.slice(cappedPinned.length);

    const projector =
      this.budget.projection === "rich"
        ? this.projectRich.bind(this)
        : this.projectLean.bind(this);

    const searchResultIds = new Set(rawSearchResults.map((b) => b._id));

    return {
      expandedQuery,
      queryWasNoisy,
      personaPrelude,
      pinnedFactsJson: JSON.stringify(
        cappedPinned.map((b) => projector(b, false)),
      ),
      relevantBeliefsJson: JSON.stringify(
        cappedRelevant.map((b) =>
          this.budget.projection === "lean"
            ? this.projectLean(b, searchResultIds.has(b._id as string))
            : this.projectRich(b),
        ),
      ),
      openQuestionsJson: JSON.stringify(
        questions.map((q) => this.projectQuestion(q)),
      ),
      beliefCount: capped.length,
      questionCount: questions.length,
      truncated,
      searchScores,
    };
  }

  private clip(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
  }

  private truncate(s: string): string {
    return this.clip(s, this.budget.maxCharsPerBelief);
  }

  private projectRich(b: Belief): Record<string, unknown> {
    return {
      id: b._id,
      type: b.type,
      canonical_name: b.canonical_name,
      aliases: b.aliases,
      content: this.truncate(b.content),
      why_it_matters: b.why_it_matters,
      scope: b.scope,
      epistemic_status: b.epistemic_status,
      confidence: b.confidence,
      pinned: b.pinned,
    };
  }

  private projectLean(
    b: Belief,
    isSearchResult = false,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      id: b._id,
      canonical_name: b.canonical_name,
      content: this.truncate(b.content),
      why_it_matters: b.why_it_matters,
    };
    if (b.type === "open_question" || b.type === "decision") {
      out.type = b.type;
    }
    if (b.epistemic_status !== "active") {
      out.epistemic_status = b.epistemic_status;
    }
    if (b.confidence < 0.65) {
      out.confidence = b.confidence;
    }
    if (isSearchResult && b.aliases?.length) {
      out.aliases = b.aliases;
    }
    return out;
  }

  private projectQuestion(q: Belief): Record<string, unknown> {
    return {
      id: q._id,
      canonical_name: q.canonical_name,
      content: this.truncate(q.content),
      scope: q.scope,
    };
  }
}

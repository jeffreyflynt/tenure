import type { Collection } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { ScoredBelief } from "./beliefsReader.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

// nomic-embed-text produces 768-dim vectors.
// If you switch to another embedding model, update to the dimensions for that model.
export const VECTOR_DIMENSIONS = 768;

export const VECTOR_INDEX_NAME = "beliefs_vector";

/**
 * Fetch an embedding from Ollama for a given text string.
 * Throws if Ollama is unreachable or returns a non-200 status.
 */
export async function ollamaEmbed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!res.ok) {
    throw new Error(
      `Ollama embedding failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as { embedding: number[] };
  return data.embedding;
}

/**
 * Build the text that gets embedded for a belief.
 *
 * Mirrors exactly what BM25 searches: canonical_name + aliases only.
 * Content is deliberately excluded so the comparison is apples-to-apples.
 */
export function beliefEmbedText(belief: {
  canonical_name: string;
  aliases: string[];
}): string {
  const parts = [belief.canonical_name, ...belief.aliases].filter(Boolean);
  return parts.join(" ");
}

export interface VectorSearchOptions {
  limit?: number;
  numCandidates?: number;
  scoreDetails?: boolean;
  excludeIds?: Set<string>;
}

export class BeliefsReaderVector {
  constructor(
    private readonly col: Collection<Belief & { embedding?: number[] }>,
    private readonly embed: (text: string) => Promise<number[]> = ollamaEmbed,
  ) {}

  /**
   * Vector search over beliefs using $vectorSearch (Atlas Search).
   *
   * Applies the same hard filters as BeliefsReader.searchText:
   *   - user_id match
   *   - superseded_by: null
   *   - resolved_at: null
   *   - excludes open_question and expertise subtypes
   *
   * Scope filtering is applied as a post-search $match, identical to BM25,
   * so the comparison is fair.
   *
   * Returns ScoredBelief[] with _searchScore set to the cosine similarity
   * score from $vectorSearch, so the report format is identical to BM25.
   */
  async searchText(
    userId: string,
    query: string,
    scope?: string[],
    opts: VectorSearchOptions = {},
  ): Promise<ScoredBelief[]> {
    const { limit = 20, numCandidates = 150, excludeIds } = opts;

    if (!query.trim()) return [];

    const queryVector = await this.embed(query);

    // $vectorSearch filter supports a limited expression syntax.
    // We can only use equality and range operators here — no $or, no $nin.
    // user_id, superseded_by, and resolved_at are covered by the pre-filter.
    // open_question / expertise exclusion is applied in the post-$match below.
    const vectorStage = {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: "embedding",
        queryVector,
        numCandidates,
        limit: limit * 4,
        filter: {
          user_id: { $eq: userId },
          superseded_by: { $eq: null },
          resolved_at: { $eq: null },
        },
      },
    };

    const postMatch: Record<string, unknown> = {
      type: { $nin: ["open_question"] },
      subtype: { $ne: "expertise" },
    };

    if (scope?.length) {
      postMatch.scope = { $in: scope };
    }

    if (excludeIds?.size) {
      postMatch._id = { $nin: [...excludeIds] };
    }

    const pipeline = [
      vectorStage,
      {
        $addFields: {
          _searchScore: { $meta: "vectorSearchScore" },
        },
      },
      { $match: postMatch },
      { $limit: limit },
    ];

    return this.col.aggregate<ScoredBelief>(pipeline).toArray();
  }
}

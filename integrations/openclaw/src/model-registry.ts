import type { TenureClient } from "./tenure-client.js";

interface CachedModels {
  models: Set<string>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class ModelRegistry {
  private cache: CachedModels | null = null;
  private inflight: Promise<Set<string>> | null = null;

  constructor(private readonly client: TenureClient) {}

  /**
   * Returns true if the given model ID is supported by Tenure for extraction.
   * Uses cached result when fresh enough.
   */
  async isSupported(modelId: string): Promise<boolean> {
    const models = await this.getSupportedModels();
    return models.has(normalizeModelId(modelId));
  }

  /**
   * Returns the set of supported model IDs from Tenure.
   * Refreshes cache if stale.
   */
  async getSupportedModels(): Promise<Set<string>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.models;
    }

    if (this.inflight) return this.inflight;

    this.inflight = this.fetchSupportedModels().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  private async fetchSupportedModels(): Promise<Set<string>> {
    try {
      const providers = await this.client.getProviders();
      const configured = providers.filter((p) => p.configured);

      const modelSets = await Promise.all(
        configured.map(async (p) => {
          try {
            const models = await this.client.probeModels(p.id);
            return models
              .filter((m) => m.supported)
              .map((m) => normalizeModelId(m.id));
          } catch {
            return [];
          }
        }),
      );

      const all = new Set(modelSets.flat());
      this.cache = { models: all, fetchedAt: Date.now() };
      return all;
    } catch {
      return new Set();
    }
  }

  /**
   * Registers a newly validated model into the cache without a full refresh.
   */
  addModel(modelId: string): void {
    if (this.cache) {
      this.cache.models.add(normalizeModelId(modelId));
    }
  }

  invalidate(): void {
    this.cache = null;
  }
}

/**
 * Normalize model IDs for comparison.
 * Strips provider prefixes like "anthropic/" or "openai/" so
 * "us.anthropic.claude-sonnet-4-6" matches "claude-sonnet-4-6".
 */
export function normalizeModelId(modelId: string): string {
  return modelId
    .replace(/^(us\.|eu\.|ap\.)/, "") // AWS region prefixes
    .replace(/^anthropic\./, "") // Bedrock anthropic. prefix
    .replace(/^amazon\./, "") // Bedrock amazon. prefix
    .toLowerCase();
}

/**
 * Given a model ID that may be provider-qualified, return the bare model ID
 * that Tenure expects to forward to the upstream provider.
 */
export function extractBareModelId(modelId: string): string {
  return normalizeModelId(modelId);
}

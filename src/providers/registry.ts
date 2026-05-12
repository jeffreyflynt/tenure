import type { ProviderAdapter, ModelInfo } from "./types.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private modelCache: { data: ModelInfo[]; expiry: number } | null = null;

  register(adapter: ProviderAdapter): this {
    this.adapters.set(adapter.id, adapter);
    this.modelCache = null;
    return this;
  }

  unregister(id: string): boolean {
    const removed = this.adapters.delete(id);
    if (removed) this.modelCache = null;
    return removed;
  }

  resolve(providerId: string): ProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new ProviderNotConfiguredError(providerId);
    return adapter;
  }

  detectFromModel(model: string, fallback: string): ProviderAdapter {
    const lower = model.toLowerCase();
    let target = fallback;

    if (/^claude-/i.test(lower) || /^anthropic\./i.test(lower)) {
      target = "anthropic";
    } else if (/^gpt-/i.test(lower) || /^o[134]-/.test(lower)) {
      target = "openai";
    } else if (/^amazon\./i.test(lower)) {
      target = "bedrock";
    }

    return this.resolve(target);
  }

  listRegistered(): string[] {
    return [...this.adapters.keys()];
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() < this.modelCache.expiry) {
      return this.modelCache.data;
    }

    const results = await Promise.all(
      [...this.adapters.values()]
        .filter((a) => a.listModels)
        .map((a) => a.listModels!().catch(() => [] as ModelInfo[])),
    );

    const data = results.flat();
    this.modelCache = { data, expiry: Date.now() + CACHE_TTL_MS };
    return data;
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: string) {
    super(`provider '${provider}' not configured — add credentials in the UI`);
  }
}

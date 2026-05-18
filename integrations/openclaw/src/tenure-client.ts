import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export interface TenureConfig {
  baseUrl: string;
  token: string;
}

export interface TenureProvider {
  id: string;
  configured: boolean;
  registered: boolean;
}

export interface TenureModel {
  id: string;
  supported: boolean;
  family: string | null;
  tier: string | null;
}

export interface TenureHealth {
  ok: boolean;
}

/**
 * Resolves the Tenure bearer token using the following priority:
 *
 * 1. Explicit value passed in plugin config
 * 2. ~/.tenure/token  — bare token file written by Tenure on first boot
 * 3. ~/.tenure/.env   — TENURE_TOKEN= line (manual / legacy installs)
 * 4. TENURE_TOKEN environment variable
 */
export function resolveToken(configToken: string | undefined): string {
  if (configToken) return configToken;

  const tokenDir = process.env.TENURE_HOME ?? join(homedir(), ".tenure");
  const tokenFile = join(tokenDir, "token");
  try {
    const contents = readFileSync(tokenFile, "utf8").trim();
    if (contents) return contents;
  } catch {}

  const envFile = join(homedir(), ".tenure", ".env");
  try {
    const contents = readFileSync(envFile, "utf8");
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("TENURE_TOKEN=")) {
        return trimmed.slice("TENURE_TOKEN=".length).trim();
      }
    }
  } catch {}

  if (process.env.TENURE_TOKEN) return process.env.TENURE_TOKEN;

  return "";
}

export function createTenureClient(cfg: TenureConfig) {
  const { baseUrl, token } = cfg;

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`Tenure ${path} → HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  async function put<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Tenure ${path} → HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Tenure ${path} → HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }

  return {
    async health(): Promise<boolean> {
      try {
        const data = await get<TenureHealth>("/healthz");
        return data.ok === true;
      } catch {
        return false;
      }
    },

    async getProviders(): Promise<TenureProvider[]> {
      const data = await get<{ providers: TenureProvider[] }>(
        "/admin/providers",
      );
      return data.providers;
    },

    async getConfig(): Promise<Record<string, unknown>> {
      return get<Record<string, unknown>>("/admin/config");
    },

    async probeModels(providerId: string): Promise<TenureModel[]> {
      const data = await get<{
        models: TenureModel[];
        supports_listing: boolean;
      }>(`/v1/onboarding/probe-models/${providerId}`);
      return data.models;
    },

    async validateModel(providerId: string, modelId: string): Promise<boolean> {
      try {
        await post<{ ok: boolean }>("/v1/onboarding/validate-model", {
          provider_id: providerId,
          model_id: modelId,
        });
        return true;
      } catch {
        return false;
      }
    },

    async setConfigValue(key: string, value: unknown): Promise<void> {
      await put(`/admin/config/${key}`, { value });
    },

    async setSeededAgent(agentId: string): Promise<void> {
      await put(`/admin/config/seeded_agent:${agentId}`, { value: true });
    },

    async ingestBeliefs(params: {
      text: string;
      source_label: string;
      scope: string[];
    }): Promise<void> {
      await post<{ ok: boolean }>("/v1/beliefs/ingest", params);
    },
  };
}

export type TenureClient = ReturnType<typeof createTenureClient>;

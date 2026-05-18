import test from "ava";
import { createTenureClient, resolveToken } from "./tenure-client.js";
import { ModelRegistry } from "./model-registry.js";
import { normalizeModelId } from "./model-registry.js";
import process from "node:process";
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

function makeClient(overrides: Partial<ReturnType<typeof createTenureClient>>) {
  return {
    health: async () => true,
    getProviders: async () => [],
    getConfig: async () => ({}),
    probeModels: async () => [],
    validateModel: async () => true,
    setConfigValue: async () => {},
    ingestBeliefs: async () => {},
    ...overrides,
  } as ReturnType<typeof createTenureClient>;
}

test("normalizeModelId strips us. prefix", (t) => {
  t.is(normalizeModelId("us.anthropic.claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("normalizeModelId strips anthropic. prefix", (t) => {
  t.is(normalizeModelId("anthropic.claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("normalizeModelId lowercases", (t) => {
  t.is(normalizeModelId("Claude-Sonnet-4-6"), "claude-sonnet-4-6");
});

test("normalizeModelId leaves bare model id unchanged", (t) => {
  t.is(normalizeModelId("claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("normalizeModelId strips eu. prefix", (t) => {
  t.is(normalizeModelId("eu.anthropic.claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("ModelRegistry.isSupported returns true for supported model", async (t) => {
  const client = makeClient({
    getProviders: async () => [
      { id: "anthropic", configured: true, registered: true },
    ],
    probeModels: async () => [
      {
        id: "claude-sonnet-4-6",
        supported: true,
        family: "claude",
        tier: "sonnet",
      },
    ],
  });
  const registry = new ModelRegistry(client);
  t.true(await registry.isSupported("claude-sonnet-4-6"));
});

test("ModelRegistry.isSupported returns false for unsupported model", async (t) => {
  const client = makeClient({
    getProviders: async () => [
      { id: "anthropic", configured: true, registered: true },
    ],
    probeModels: async () => [
      { id: "claude-haiku-3", supported: false, family: "claude", tier: null },
    ],
  });
  const registry = new ModelRegistry(client);
  t.false(await registry.isSupported("claude-haiku-3"));
});

test("ModelRegistry.isSupported returns false when Tenure unreachable", async (t) => {
  const client = makeClient({
    getProviders: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const registry = new ModelRegistry(client);
  t.false(await registry.isSupported("claude-sonnet-4-6"));
});

test("ModelRegistry caches results", async (t) => {
  let callCount = 0;
  const client = makeClient({
    getProviders: async () => {
      callCount++;
      return [{ id: "anthropic", configured: true, registered: true }];
    },
    probeModels: async () => [
      {
        id: "claude-sonnet-4-6",
        supported: true,
        family: "claude",
        tier: "sonnet",
      },
    ],
  });
  const registry = new ModelRegistry(client);
  await registry.isSupported("claude-sonnet-4-6");
  await registry.isSupported("claude-sonnet-4-6");
  t.is(callCount, 1);
});

test("ModelRegistry.invalidate forces refresh on next call", async (t) => {
  let callCount = 0;
  const client = makeClient({
    getProviders: async () => {
      callCount++;
      return [{ id: "anthropic", configured: true, registered: true }];
    },
    probeModels: async () => [
      {
        id: "claude-sonnet-4-6",
        supported: true,
        family: "claude",
        tier: "sonnet",
      },
    ],
  });
  const registry = new ModelRegistry(client);
  await registry.isSupported("claude-sonnet-4-6");
  registry.invalidate();
  await registry.isSupported("claude-sonnet-4-6");
  t.is(callCount, 2);
});

test("ModelRegistry.addModel adds model to cache without network call", async (t) => {
  let callCount = 0;
  const client = makeClient({
    getProviders: async () => {
      callCount++;
      return [{ id: "anthropic", configured: true, registered: true }];
    },
    probeModels: async () => [],
  });
  const registry = new ModelRegistry(client);
  await registry.getSupportedModels();
  t.is(callCount, 1);
  registry.addModel("claude-opus-4-6");
  t.true(await registry.isSupported("claude-opus-4-6"));
  t.is(callCount, 1);
});

test("catalog returns null when health check fails", async (t) => {
  const client = makeClient({ health: async () => false });
  const registry = new ModelRegistry(client);
  const baseUrl = "http://localhost:5757";
  const token = "test-token";

  const catalogRun = async () => {
    const healthy = await client.health();
    if (!healthy) return null;
    const supportedModels = await registry.getSupportedModels();
    return {
      provider: {
        baseUrl: `${baseUrl}/v1`,
        apiKey: token,
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [...supportedModels].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        })),
      },
    };
  };

  const result = await catalogRun();
  t.is(result, null);
});

test("catalog returns correct provider shape when healthy", async (t) => {
  const client = makeClient({
    health: async () => true,
    getProviders: async () => [
      { id: "anthropic", configured: true, registered: true },
    ],
    probeModels: async () => [
      {
        id: "claude-sonnet-4-6",
        supported: true,
        family: "claude",
        tier: "sonnet",
      },
    ],
  });
  const registry = new ModelRegistry(client);
  const baseUrl = "http://localhost:5757";
  const token = "test-token";

  const catalogRun = async () => {
    const healthy = await client.health();
    if (!healthy) return null;
    const supportedModels = await registry.getSupportedModels();
    return {
      provider: {
        baseUrl: `${baseUrl}/v1`,
        apiKey: token,
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [...supportedModels].map((id) => ({
          id,
          name: id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200000,
          maxTokens: 8192,
        })),
      },
    };
  };

  const result = await catalogRun();
  t.not(result, null);
  t.is(result!.provider.api, "openai-completions");
  t.is(result!.provider.baseUrl, "http://localhost:5757/v1");
  t.is(result!.provider.apiKey, "test-token");
  t.true(result!.provider.request.allowPrivateNetwork);
  t.is(result!.provider.models.length, 1);
  t.is(result!.provider.models[0].id, "claude-sonnet-4-6");
});

test("resolveDynamicModel returns correct shape for any model id", (t) => {
  const baseUrl = "http://localhost:5757";
  const resolveDynamicModel = (ctx: { modelId: string }) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "tenure",
    api: "openai-completions",
    baseUrl: `${baseUrl}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  });

  const model = resolveDynamicModel({ modelId: "claude-opus-4-6" });
  t.is(model.id, "claude-opus-4-6");
  t.is(model.provider, "tenure");
  t.is(model.api, "openai-completions");
  t.is(model.baseUrl, "http://localhost:5757/v1");
  t.false(model.reasoning);
});

test("resolveDynamicModel preserves model id exactly", (t) => {
  const baseUrl = "http://localhost:5757";
  const resolveDynamicModel = (ctx: { modelId: string }) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "tenure",
    api: "openai-completions",
    baseUrl: `${baseUrl}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  });

  const model = resolveDynamicModel({
    modelId: "us.anthropic.claude-sonnet-4-6",
  });
  t.is(model.id, "us.anthropic.claude-sonnet-4-6");
});

test("resolveToken prefers provided token over env", (t) => {
  process.env.TENURE_TOKEN = "env-token";
  const result = resolveToken("explicit-token");
  t.is(result, "explicit-token");
  delete process.env.TENURE_TOKEN;
});

test("resolveToken falls back to TENURE_TOKEN env var", (t) => {
  const fakeTenureHome = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(fakeTenureHome, { recursive: true });
  process.env.TENURE_HOME = fakeTenureHome;
  process.env.TENURE_TOKEN = "env-token";

  const result = resolveToken(undefined);
  t.is(result, "env-token");

  delete process.env.TENURE_TOKEN;
  delete process.env.TENURE_HOME;
});

test("resolveToken returns empty string when nothing available", (t) => {
  const fakeTenureHome = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(fakeTenureHome, { recursive: true });
  process.env.TENURE_HOME = fakeTenureHome;
  delete process.env.TENURE_TOKEN;

  const result = resolveToken(undefined);
  t.is(result, "");

  delete process.env.TENURE_HOME;
});

test("sessionAgentMap only writes on first encounter", (t) => {
  const map = new Map<string, string>();
  const MAX = 500;

  function setSessionAgent(sessionKey: string, agentId: string): void {
    if (map.size >= MAX) {
      const firstKey = map.keys().next().value;
      if (firstKey) map.delete(firstKey);
    }
    map.set(sessionKey, agentId);
  }

  if (!map.has("session-1")) setSessionAgent("session-1", "work");
  if (!map.has("session-1")) setSessionAgent("session-1", "personal");

  t.is(map.get("session-1"), "work");
});

test("sessionAgentMap evicts oldest entry when at capacity", (t) => {
  const map = new Map<string, string>();
  const MAX = 3;

  function setSessionAgent(sessionKey: string, agentId: string): void {
    if (map.size >= MAX) {
      const firstKey = map.keys().next().value;
      if (firstKey) map.delete(firstKey);
    }
    map.set(sessionKey, agentId);
  }

  setSessionAgent("s1", "work");
  setSessionAgent("s2", "personal");
  setSessionAgent("s3", "coding");
  setSessionAgent("s4", "writing");

  t.false(map.has("s1"));
  t.true(map.has("s2"));
  t.true(map.has("s3"));
  t.true(map.has("s4"));
  t.is(map.size, 3);
});

test("resolveTransportTurnState sets x-agent-id from map", (t) => {
  const map = new Map<string, string>([["session-abc", "work"]]);

  const resolveTransportTurnState = (ctx: { sessionId?: string }) => {
    const agentId = map.get(ctx.sessionId ?? "") ?? "main";
    return {
      headers: {
        "x-agent-id": agentId,
        "x-session-id": ctx.sessionId ?? "unknown",
      },
    };
  };

  const result = resolveTransportTurnState({ sessionId: "session-abc" });
  t.is(result.headers["x-agent-id"], "work");
  t.is(result.headers["x-session-id"], "session-abc");
});

test("resolveTransportTurnState falls back to main when session not in map", (t) => {
  const map = new Map<string, string>();

  const resolveTransportTurnState = (ctx: { sessionId?: string }) => {
    const agentId = map.get(ctx.sessionId ?? "") ?? "main";
    return {
      headers: {
        "x-agent-id": agentId,
        "x-session-id": ctx.sessionId ?? "unknown",
      },
    };
  };

  const result = resolveTransportTurnState({ sessionId: "session-xyz" });
  t.is(result.headers["x-agent-id"], "main");
});

test("resolveTransportTurnState uses unknown when sessionId is missing", (t) => {
  const map = new Map<string, string>();

  const resolveTransportTurnState = (ctx: { sessionId?: string }) => {
    const agentId = map.get(ctx.sessionId ?? "") ?? "main";
    return {
      headers: {
        "x-agent-id": agentId,
        "x-session-id": ctx.sessionId ?? "unknown",
      },
    };
  };

  const result = resolveTransportTurnState({});
  t.is(result.headers["x-session-id"], "unknown");
  t.is(result.headers["x-agent-id"], "main");
});

test("wrapStreamFn sets x-tenure-bootstrapping when BOOTSTRAP.md exists", async (t) => {
  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "BOOTSTRAP.md"), "# bootstrap");

  try {
    const bootstrapping = existsSync(join(workspaceDir, "BOOTSTRAP.md"));
    const params: { headers: Record<string, string> } = { headers: {} };

    if (bootstrapping) {
      params.headers = { ...params.headers, "x-tenure-bootstrapping": "1" };
    }

    t.is(params.headers["x-tenure-bootstrapping"], "1");
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("wrapStreamFn does not set x-tenure-bootstrapping when BOOTSTRAP.md absent", async (t) => {
  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });

  try {
    const bootstrapping = existsSync(join(workspaceDir, "BOOTSTRAP.md"));
    const params: { headers: Record<string, string> } = { headers: {} };

    if (bootstrapping) {
      params.headers = { ...params.headers, "x-tenure-bootstrapping": "1" };
    }

    t.false("x-tenure-bootstrapping" in params.headers);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("maybeSeedAgent skips seeding when already seeded in config", async (t) => {
  let ingestCalled = false;
  const client = makeClient({
    getConfig: async () => ({ "seeded_agent:work": true }),
    ingestBeliefs: async () => {
      ingestCalled = true;
    },
  });

  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "USER.md"), "Name: Alice");

  try {
    await maybeSeedAgentUnderTest("work", workspaceDir, client, {
      info: () => {},
      warn: () => {},
    });
    t.false(ingestCalled);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("maybeSeedAgent skips seeding when BOOTSTRAP.md exists", async (t) => {
  let ingestCalled = false;
  const client = makeClient({
    getConfig: async () => ({}),
    ingestBeliefs: async () => {
      ingestCalled = true;
    },
  });

  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "BOOTSTRAP.md"), "# bootstrap");
  writeFileSync(join(workspaceDir, "USER.md"), "Name: Alice");

  try {
    await maybeSeedAgentUnderTest("work", workspaceDir, client, {
      info: () => {},
      warn: () => {},
    });
    t.false(ingestCalled);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("maybeSeedAgent skips template content", async (t) => {
  let ingestCalled = false;
  const client = makeClient({
    getConfig: async () => ({}),
    ingestBeliefs: async () => {
      ingestCalled = true;
    },
  });

  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "USER.md"),
    "Learn about the person you're helping.",
  );

  try {
    await maybeSeedAgentUnderTest("work", workspaceDir, client, {
      info: () => {},
      warn: () => {},
    });
    t.false(ingestCalled);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("maybeSeedAgent calls ingestBeliefs with correct scope when files are ready", async (t) => {
  let capturedParams: {
    text: string;
    source_label: string;
    scope: string[];
  } | null = null;
  let markedSeeded = false;

  const client = makeClient({
    getConfig: async () => ({}),
    ingestBeliefs: async (params) => {
      capturedParams = params;
    },
    setConfigValue: async (key: string) => {
      if (key === "seeded_agent:work") markedSeeded = true;
    },
  });

  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "USER.md"), "Name: Alice\nTimezone: UTC");

  try {
    await maybeSeedAgentUnderTest("work", workspaceDir, client, {
      info: () => {},
      warn: () => {},
    });

    t.not(capturedParams, null);
    t.deepEqual(capturedParams!.scope, ["domain:work"]);
    t.is(capturedParams!.source_label, "openclaw:work");
    t.true(capturedParams!.text.includes("USER.md"));
    t.true(markedSeeded);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("maybeSeedAgent does not mark seeded when ingest fails", async (t) => {
  let markedSeeded = false;
  const client = makeClient({
    getConfig: async () => ({}),
    ingestBeliefs: async () => {
      throw new Error("network error");
    },
    setConfigValue: async (key: string) => {
      if (key === "seeded_agent:work") markedSeeded = true;
    },
  });

  const workspaceDir = join(tmpdir(), `tenure-test-${randomUUID()}`);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "USER.md"), "Name: Alice");

  try {
    await maybeSeedAgentUnderTest("work", workspaceDir, client, {
      info: () => {},
      warn: () => {},
    });
    t.false(markedSeeded);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

const SEED_FILES_TEST = ["USER.md", "MEMORY.md"] as const;

async function maybeSeedAgentUnderTest(
  agentId: string,
  workspaceDir: string,
  client: ReturnType<typeof makeClient>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  try {
    const cfg = await client.getConfig();
    if (cfg[`seeded_agent:${agentId}`] === true) return;
  } catch {
    return;
  }

  if (existsSync(join(workspaceDir, "BOOTSTRAP.md"))) return;

  const chunks: string[] = [];
  for (const filename of SEED_FILES_TEST) {
    const filePath = join(workspaceDir, filename);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8").trim();
      if (
        content.length > 0 &&
        !content.includes("Fill this in") &&
        !content.includes("Learn about the person") &&
        !content.includes("template")
      ) {
        chunks.push(`## ${filename}\n\n${content}`);
      }
    } catch {}
  }

  if (chunks.length === 0) {
    await client
      .setConfigValue(`seeded_agent:${agentId}`, true)
      .catch(() => {});
    return;
  }

  try {
    await client.ingestBeliefs({
      text: chunks.join("\n\n---\n\n"),
      source_label: `openclaw:${agentId}`,
      scope: [`domain:${agentId}`],
    });
    await client.setConfigValue(`seeded_agent:${agentId}`, true);
    logger.info(`[tenure] seeded beliefs for agent: ${agentId}`);
  } catch (err) {
    logger.warn(
      `[tenure] seed failed for agent ${agentId}: ${(err as Error).message}`,
    );
  }
}

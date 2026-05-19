import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTenureClient, resolveToken } from "./tenure-client.js";
import { ModelRegistry } from "./model-registry.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

interface PluginConfig {
  baseUrl?: string;
  token?: string;
  port?: number;
}

const SEED_FILES = ["USER.md", "MEMORY.md"] as const;

async function maybeSeedAgent(
  agentId: string,
  workspaceDir: string,
  client: ReturnType<typeof createTenureClient>,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<void> {
  try {
    const cfg = await client.getConfig();
    if (cfg[`seeded_agent:${agentId}`] === true) return;
  } catch {
    // Tenure unreachable — skip silently, will retry next turn
    return;
  }

  // If BOOTSTRAP.md exists the agent hasn't finished its first-run ritual yet.
  // USER.md and MEMORY.md may still be empty templates — wait for next turn.
  const bootstrapPath = join(workspaceDir, "BOOTSTRAP.md");
  if (existsSync(bootstrapPath)) return;

  const chunks: string[] = [];

  for (const filename of SEED_FILES) {
    const filePath = join(workspaceDir, filename);
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, "utf8").trim();
      if (content.length > 0) {
        chunks.push(`## ${filename}\n\n${content}`);
      }
    } catch {
      // unreadable — skip
    }
  }

  if (chunks.length === 0) {
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

export default definePluginEntry({
  id: "tenure",
  name: "Tenure",
  description:
    "Persistent memory for OpenClaw that stores beliefs as actionable instructions, not facts. " +
    "Zero-config per-agent isolation. Your work, personal, and side-project agents never share context. " +
    "Fully local proxy, nothing leaves localhost.",

  register(api) {
    const logger = api.logger!;
    const pluginCfg = (api.pluginConfig ?? {}) as PluginConfig;

    const port = pluginCfg.port ?? 5757;
    const baseUrl = pluginCfg.baseUrl ?? `http://localhost:${port}`;
    const token = resolveToken(pluginCfg.token);

    if (!token) {
      logger.warn(
        "[tenure] No token found. Install Tenure and run !tenure onboarding, " +
          "or set TENURE_TOKEN in your environment.",
      );
      return;
    }

    const client = createTenureClient({ baseUrl, token });
    const registry = new ModelRegistry(client);

    api.on(
      "session_start",
      async (_event, ctx) => {
        const agentId =
          ((ctx as Record<string, unknown>)["agentId"] as string | undefined) ??
          "main";
        if (agentId === "main") return;

        try {
          const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(
            api.config,
            agentId,
          );
          maybeSeedAgent(agentId, workspaceDir, client, logger).catch(() => {});
        } catch {
          // workspace resolution failed — seeding will retry on next turn
        }
      },
      { priority: 0 },
    );

    api.registerProvider({
      id: "tenure",
      label: "Tenure (Memory Proxy)",
      auth: [],

      resolveTransportTurnState: (ctx) => {
        const agentId =
          ((ctx as Record<string, unknown>)["agentId"] as string | undefined) ??
          "main";

        if (agentId !== "main") {
          try {
            const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(
              api.config,
              agentId,
            );
            const bootstrapping = existsSync(
              join(workspaceDir, "BOOTSTRAP.md"),
            );
            if (!bootstrapping) {
              maybeSeedAgent(agentId, workspaceDir, client, logger).catch(
                () => {},
              );
            }
          } catch {
            // workspace resolution failed — seeding will retry next turn
          }
        }

        return {
          headers: {
            "x-agent-id": agentId,
            "x-session-id": ctx.sessionId ?? "unknown",
          },
        };
      },

      catalog: {
        order: "simple",
        run: async () => {
          const healthy = await client.health();
          if (!healthy) {
            logger.warn(
              "[tenure] Tenure not reachable — returning empty catalog",
            );
            return null;
          }

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
        },
      },

      resolveDynamicModel: (ctx) => ({
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
      }),

      wrapStreamFn: (ctx) => {
        if (!ctx.streamFn) return undefined;
        const inner = ctx.streamFn;

        return async (params, ...rest) => {
          const workspaceDir = ctx.workspaceDir ?? ctx.agentDir;
          const bootstrapping = workspaceDir
            ? existsSync(join(workspaceDir, "BOOTSTRAP.md"))
            : false;

          if (bootstrapping) {
            params.headers = {
              ...params.headers,
              "x-tenure-bootstrapping": "1",
            };
          }

          return inner(params, ...rest);
        };
      },
    });

    logger.info(`[tenure] Provider registered — proxy at ${baseUrl}`);
  },
});

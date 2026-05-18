import type { Db } from "mongodb";
import type { ProviderAdapter } from "../providers/types.js";
import type { FastifyBaseLogger } from "fastify";
import type { SessionPatch } from "../session/manager.js";
import type { RuntimeConfig } from "../config/runtime.js";

export interface ScopeDetectorDeps {
  db: Db;
  adapter: () => ProviderAdapter;
  modelId: string;
}

export interface InterceptResult {
  message: string;
  newScope: string[];
}

export interface ExtractInterceptResult {
  message: string;
}

export interface SessionInterceptResult {
  message: string;
  sessionId: string;
  agentId: string;
}

export type CommandAction = "off" | "on" | "global-off" | "global-on";

const SCOPE_PATTERN =
  /^(domain:[a-z0-9_-]+(\/[a-z0-9_-]+)*|project:[a-z0-9_-]+|user:universal)$/;

const VALID_ACTIONS: CommandAction[] = ["on", "off", "global-on", "global-off"];

export function validateCommandInput(
  type: "scope",
  parts: string[],
): { valid: true; parts: string[] } | { valid: false; message: string };

export function validateCommandInput(
  type: "extract" | "inject",
  action: CommandAction,
): { valid: true } | { valid: false; message: string };

export function validateCommandInput(
  type: "scope" | "extract" | "inject",
  input: string[] | CommandAction,
): { valid: true; parts?: string[] } | { valid: false; message: string } {
  if (type === "scope") {
    const parts = input as string[];

    if (parts.length === 0) {
      return {
        valid: false,
        message:
          "No scope provided. Usage: `!scope domain:code` or `!scope domain:code domain:writing`",
      };
    }

    const invalid = parts.filter((s) => !SCOPE_PATTERN.test(s));
    if (invalid.length > 0) {
      return {
        valid: false,
        message:
          `Invalid scope format: ${invalid.map((s) => `\`${s}\``).join(", ")}. ` +
          `Use \`domain:code\`, \`domain:code/typescript\`, or \`project:my-project\`.`,
      };
    }

    return { valid: true, parts };
  }

  const action = input as CommandAction;
  if (!VALID_ACTIONS.includes(action)) {
    return {
      valid: false,
      message:
        `Unknown ${type} command. Valid commands: ` +
        `\`!${type} on\`, \`!${type} off\`, ` +
        `\`!${type} global on\`, \`!${type} global off\`.`,
    };
  }

  return { valid: true };
}

export function expandScopeHierarchy(scopes: string[]): string[] {
  const expanded = new Set<string>();
  for (const scope of scopes) {
    expanded.add(scope);

    const parts = scope.split("/");
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        expanded.add(parts.slice(0, i).join("/"));
      }
    }
  }
  return [...expanded];
}

// If you add or change commands here, update TENURE_COMMANDS in routes/commands.ts
// to keep GET /v1/commands accurate.
export function matchScopeCommand(content: string): string | null {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  const PREFIXES = ["!scope", "set scope"] as const;

  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) {
      const after = trimmed.slice(prefix.length);
      if (after.length === 0 || /^[\s,]/.test(after)) {
        return after.trim();
      }
    }
  }
  return null;
}

export async function tryInterceptScopeCommand(
  content: string,
  sessionId: string,
  userId: string,
  deps: {
    sessions: {
      update: (
        id: string,
        userId: string,
        patch: { activeScope: string[] },
      ) => Promise<unknown>;
    };
  },
  logger: FastifyBaseLogger,
): Promise<InterceptResult | null> {
  const raw = matchScopeCommand(content);
  if (raw === null) return null;

  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const validation = validateCommandInput("scope", parts);
  if (!validation.valid) {
    return { message: validation.message, newScope: [] };
  }

  const newScope = expandScopeHierarchy(validation.parts!);

  try {
    await deps.sessions.update(sessionId, userId, { activeScope: newScope });
  } catch (err) {
    logger.warn({ err, sessionId }, "scope command: session update failed");
    return {
      message: "Failed to update scope. Try again.",
      newScope: [],
    };
  }

  return {
    message: `Scope set to: ${newScope.map((s) => `\`${s}\``).join(", ")}`,
    newScope,
  };
}

const SCOPE_DETECT_PROMPT = `You classify a user's first message into one or more scope strings.

Existing scopes for this user are provided. Match to an existing scope if the message clearly belongs there.
If no existing scope matches, suggest a new one.

Scope format rules:
- domain:<slug> — top-level domain (domain:code, domain:writing, domain:hobby, domain:teaching, domain:music)
- domain:<slug>/<tech> — technology sub-domain within a domain (domain:code/typescript, domain:code/python, domain:code/databases)
- project:<slug> — a named, specific project the user is working on
- Only use project scope when the user names a specific project explicitly

When emitting a sub-domain scope like domain:code/typescript, do NOT include the parent domain:code —
the system expands the hierarchy automatically.

Return ONLY a JSON array of the most specific scopes that apply, e.g. 
["domain:code/typescript"] not ["domain:code/typescript", "domain:code"].
If the message is ambiguous or meta (greetings, system questions), return [].
No explanation. No markdown. Only the JSON array.`;

export async function detectScopeFromMessage(
  message: string,
  existingScopes: string[],
  deps: ScopeDetectorDeps,
  logger: FastifyBaseLogger,
): Promise<string[]> {
  try {
    const userContent = existingScopes.length
      ? `Existing scopes: ${existingScopes.join(", ")}\n\nUser message: ${message.slice(0, 500)}`
      : `User message: ${message.slice(0, 500)}`;

    const adapter = deps.adapter();
    const resp = await adapter.call(
      {
        model: deps.modelId,
        messages: [{ role: "user", content: userContent }],
        temperature: 0,
        max_tokens: 64,
      },
      SCOPE_DETECT_PROMPT,
    );

    const raw = (resp.content ?? "").trim();
    const clamped = raw.slice(0, 4_000);
    const match = clamped.match(/\[[\s\S]*?\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return expandScopeHierarchy(
      parsed
        .filter(
          (s): s is string => typeof s === "string" && s.trim().length > 0,
        )
        .map((s) => s.trim()),
    );
  } catch (err) {
    logger.warn({ err }, "scope detection failed — proceeding without scope");
    return [];
  }
}

export async function fetchExistingUserScopes(
  userId: string,
  db: Db,
): Promise<string[]> {
  try {
    const scopes = await db
      .collection("beliefs")
      .distinct("scope", { user_id: userId });

    return (scopes as string[]).filter(
      (s) => s !== "user:universal" && s !== "universal",
    );
  } catch {
    return [];
  }
}

export function matchExtractCommand(content: string): CommandAction | null {
  const trimmed = content.trim().toLowerCase();

  const COMMANDS: Record<string, CommandAction> = {
    "!extract off": "off",
    "!extract on": "on",
    "!extract global off": "global-off",
    "!extract global on": "global-on",
  };

  return COMMANDS[trimmed] ?? null;
}

export async function tryInterceptExtractCommand(
  content: string,
  sessionId: string,
  userId: string,
  deps: {
    sessions: {
      update: (
        id: string,
        userId: string,
        patch: SessionPatch,
      ) => Promise<unknown>;
    };
    runtimeStore: {
      set: <K extends keyof RuntimeConfig>(
        key: K,
        value: RuntimeConfig[K],
      ) => Promise<void>;
    };
  },
  logger: FastifyBaseLogger,
): Promise<ExtractInterceptResult | null> {
  const action = matchExtractCommand(content);
  if (action === null) return null;

  const validation = validateCommandInput("extract", action);
  if (!validation.valid) {
    return { message: validation.message };
  }

  switch (action) {
    case "off":
      try {
        await deps.sessions.update(sessionId, userId, {
          extractionPaused: true,
        });
      } catch (err) {
        logger.warn(
          { err, sessionId },
          "extract command: session update failed",
        );
        return { message: "Failed to pause extraction. Try again." };
      }
      return {
        message:
          "Extraction paused for this session. Existing beliefs are still injected. " +
          "Send `!extract on` to resume, or `!extract global off` to disable permanently.",
      };

    case "on":
      try {
        await deps.sessions.update(sessionId, userId, {
          extractionPaused: false,
        });
      } catch (err) {
        logger.warn(
          { err, sessionId },
          "extract command: session update failed",
        );
        return { message: "Failed to resume extraction. Try again." };
      }
      return { message: "Extraction resumed for this session." };

    case "global-off":
      try {
        await deps.runtimeStore.set("extraction_enabled", false);
      } catch (err) {
        logger.warn({ err }, "extract command: global disable failed");
        return { message: "Failed to disable extraction globally. Try again." };
      }
      return {
        message:
          "Extraction disabled globally. No new beliefs will be extracted from any session. " +
          "Existing beliefs are still injected. Send `!extract global on` to re-enable.",
      };

    case "global-on":
      try {
        await deps.runtimeStore.set("extraction_enabled", true);
      } catch (err) {
        logger.warn({ err }, "extract command: global enable failed");
        return {
          message: "Failed to re-enable extraction globally. Try again.",
        };
      }
      return { message: "Extraction re-enabled globally." };
  }
}

export function matchInjectCommand(content: string): CommandAction | null {
  const trimmed = content.trim().toLowerCase();

  const COMMANDS: Record<string, CommandAction> = {
    "!inject off": "off",
    "!inject on": "on",
    "!inject global off": "global-off",
    "!inject global on": "global-on",
  };

  return COMMANDS[trimmed] ?? null;
}

export async function tryInterceptInjectCommand(
  content: string,
  sessionId: string,
  userId: string,
  deps: {
    sessions: {
      update: (
        id: string,
        userId: string,
        patch: SessionPatch,
      ) => Promise<unknown>;
    };
    runtimeStore: {
      set: <K extends keyof RuntimeConfig>(
        key: K,
        value: RuntimeConfig[K],
      ) => Promise<void>;
    };
  },
  logger: FastifyBaseLogger,
): Promise<ExtractInterceptResult | null> {
  const action = matchInjectCommand(content);
  if (action === null) return null;

  const validation = validateCommandInput("inject", action);
  if (!validation.valid) {
    return { message: validation.message };
  }

  switch (action) {
    case "off":
      try {
        await deps.sessions.update(sessionId, userId, {
          injectionPaused: true,
        });
      } catch (err) {
        logger.warn(
          { err, sessionId },
          "inject command: session update failed",
        );
        return { message: "Failed to pause injection. Try again." };
      }
      return {
        message:
          "Belief injection paused for this session. " +
          "Tenure is still extracting from this conversation — send `!extract off` too if you want a fully clean session. " +
          "Send `!inject on` to resume.",
      };

    case "on":
      try {
        await deps.sessions.update(sessionId, userId, {
          injectionPaused: false,
        });
      } catch (err) {
        logger.warn(
          { err, sessionId },
          "inject command: session update failed",
        );
        return { message: "Failed to resume injection. Try again." };
      }
      return { message: "Belief injection resumed for this session." };

    case "global-off":
      try {
        await deps.runtimeStore.set("injection_enabled", false);
      } catch (err) {
        logger.warn({ err }, "inject command: global disable failed");
        return { message: "Failed to disable injection globally. Try again." };
      }
      return {
        message:
          "Belief injection disabled globally. " +
          "The model will receive no context from your world model in any session. " +
          "Send `!inject global on` to re-enable.",
      };

    case "global-on":
      try {
        await deps.runtimeStore.set("injection_enabled", true);
      } catch (err) {
        logger.warn({ err }, "inject command: global enable failed");
        return {
          message: "Failed to re-enable injection globally. Try again.",
        };
      }
      return { message: "Belief injection re-enabled globally." };
  }
}

export function matchSessionCommand(
  content: string,
): { sessionKey: string; agentId: string } | null {
  const trimmed = content.trim();
  const match = trimmed.match(/^!session\s+(\S+)\s+(\S+)$/i);
  if (!match) return null;
  return { sessionKey: match[1], agentId: match[2] };
}

export async function tryInterceptSessionCommand(
  content: string,
  userId: string,
  deps: {
    sessions: {
      getOrCreate: (id: string, userId: string) => Promise<unknown>;
    };
  },
  logger: FastifyBaseLogger,
): Promise<SessionInterceptResult | null> {
  const matched = matchSessionCommand(content);
  if (!matched) return null;

  try {
    await deps.sessions.getOrCreate(matched.sessionKey, userId);
  } catch (err) {
    logger.warn(
      { err, sessionKey: matched.sessionKey },
      "session command: getOrCreate failed",
    );
  }

  return {
    message: `__session_established__`,
    sessionId: matched.sessionKey,
    agentId: matched.agentId,
  };
}

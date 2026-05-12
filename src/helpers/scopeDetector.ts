import type { Db } from "mongodb";
import type { ProviderAdapter } from "../providers/types.js";
import type { FastifyBaseLogger } from "fastify";

export interface ScopeDetectorDeps {
  db: Db;
  adapter: () => ProviderAdapter;
  modelId: string;
}

export interface InterceptResult {
  message: string;
  newScope: string[];
}

export function expandScopeHierarchy(scopes: string[]): string[] {
  const expanded = new Set<string>();
  for (const scope of scopes) {
    expanded.add(scope);
    // domain:code/typescript → also add domain:code
    // domain:code/python/async → also add domain:code/python and domain:code
    const parts = scope.split("/");
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        expanded.add(parts.slice(0, i).join("/"));
      }
    }
  }
  return [...expanded];
}

export function matchScopeCommand(content: string): string | null {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  const PREFIXES = ["!scope", "set scope"] as const;

  for (const prefix of PREFIXES) {
    if (lower.startsWith(prefix)) {
      // Must be followed by whitespace, comma, or end of string
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

  if (!raw) {
    return {
      message:
        "No scope provided. Usage: `!scope domain:code` or `!scope domain:code domain:writing`",
      newScope: [],
    };
  }

  const newScope = expandScopeHierarchy(
    raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

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

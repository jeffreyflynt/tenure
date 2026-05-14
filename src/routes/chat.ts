import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyBaseLogger } from "fastify";
import type { ServerResponse } from "node:http";

import { SessionManager, type Session } from "../session/manager.js";
import { HistoryManager, type TurnSignal } from "../history/manager.js";
import {
  splitSidecar,
  parseSidecar,
  SIDECAR_BEGIN,
} from "../sidecar/splitter.js";
import { buildSidecarInstructions } from "../sidecar/prompt.js";
import {
  ContextBuilder,
  type BuiltContext,
} from "../context/contextBuilder.js";
import {
  ProviderRegistry,
  ProviderNotConfiguredError,
} from "../providers/registry.js";
import { ExtractionJobQueue } from "../jobs/queue.js";
import type {
  ContentPart,
  Message,
  NormalizedResponse,
  ProviderAdapter,
  SystemPrompt,
  SystemPromptParts,
} from "../providers/types.ts";
import { extractText, hasBinary, hasCodeBlock } from "../helpers/content.js";
import { deriveSessionId } from "../session/derivation.js";
import { checkModelTier, listSupportedFamilies } from "../providers/tiers.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import {
  tryInterceptScopeCommand,
  detectScopeFromMessage,
  fetchExistingUserScopes,
  type ScopeDetectorDeps,
  tryInterceptExtractCommand,
  tryInterceptInjectCommand,
} from "../helpers/scopeDetector.js";
import type { ErrorLogger } from "../errors/logger.js";
import { parseClient, type ParsedClient } from "../helpers/clientDetector.js";

export interface ChatDeps {
  sessions: SessionManager;
  history: HistoryManager;
  context: ContextBuilder;
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  extractionWorker: ExtractionWorkerLike;
  userId: string;
  runtimeStore: RuntimeConfigStore;
  scopeDetector?: ScopeDetectorDeps;
  errorLogger: ErrorLogger;
}

interface ChatBody {
  model?: string;
  messages: Array<{
    role: string;
    content: string | ContentPart[];
    name?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
  metadata?: { session_id?: string; scope?: string[] };
  [key: string]: unknown;
}

interface SidecarFlags {
  hasNewBeliefs: boolean;
  hasOpenQuestion: boolean;
  topicLabel: string | null;
}

const EMPTY_CONTEXT: BuiltContext = {
  personaPrelude: "",
  pinnedFactsJson: "[]",
  expandedQuery: "",
  queryWasNoisy: false,
  relevantBeliefsJson: "[]",
  openQuestionsJson: "[]",
  beliefCount: 0,
  questionCount: 0,
  truncated: false,
  searchScores: [],
};

function readSidecarFlags(sidecarRaw: string | null): SidecarFlags {
  if (!sidecarRaw) {
    return { hasNewBeliefs: false, hasOpenQuestion: false, topicLabel: null };
  }
  const parsed = parseSidecar(sidecarRaw);
  if (!parsed) {
    return { hasNewBeliefs: false, hasOpenQuestion: false, topicLabel: null };
  }
  const hasNewBeliefs =
    Array.isArray(parsed.new_beliefs) && parsed.new_beliefs.length > 0;
  const hasOpenQuestion =
    Array.isArray(parsed.new_open_questions) &&
    parsed.new_open_questions.length > 0;
  const topicLabel =
    typeof parsed.topic_label === "string" && parsed.topic_label.trim()
      ? parsed.topic_label.trim().toLowerCase()
      : null;
  return { hasNewBeliefs, hasOpenQuestion, topicLabel };
}

export function registerChatRoute(app: FastifyInstance, deps: ChatDeps): void {
  app.post<{ Body: ChatBody }>("/v1/chat/completions", async (req, reply) => {
    const body = req.body;

    if (!body?.messages?.length) {
      return reply
        .code(400)
        .send({ error: { message: "messages is required" } });
    }

    const { userId } = deps;

    const requestedModel = body.model;
    if (!requestedModel) {
      return reply.code(400).send({ error: { message: "model is required" } });
    }

    const tierResult = checkModelTier(requestedModel);
    if (!tierResult.supported && tierResult.family !== null) {
      return reply.code(422).send({
        error: {
          message: tierResult.reason,
          type: "model_not_supported",
          supported_families: listSupportedFamilies(),
        },
      });
    }
    const tierWarning = !tierResult.supported
      ? `Model "${requestedModel}" is not in a verified tier. Sidecar extraction may be unreliable.`
      : null;

    let adapter: ProviderAdapter;
    try {
      adapter = deps.providers.detectFromModel(requestedModel, "openai");
    } catch (e) {
      if (e instanceof ProviderNotConfiguredError) {
        return reply.code(502).send({
          error: {
            message: `No credentials for provider detected from model "${requestedModel}"`,
            type: "provider_not_configured",
          },
        });
      }
      throw e;
    }

    const {
      model,
      messages,
      stream,
      temperature,
      max_tokens,
      user,
      metadata,
      ...passThrough
    } = body;

    let sessionId: string;
    try {
      sessionId =
        metadata?.session_id ??
        (req.headers["x-session-id"] as string | undefined) ??
        deriveSessionId(messages as Message[], userId, undefined);
    } catch (err) {
      req.log.warn({ err }, "session derivation failed — using random UUID");
      sessionId = randomUUID();
    }

    let session: (Session & { providerId: string; model: string }) | null =
      null;
    try {
      const raw = await deps.sessions.getOrCreate(sessionId, userId);
      const needsBind =
        !raw.providerId || !raw.model || raw.model !== requestedModel;

      if (needsBind) {
        const updated = await deps.sessions.update(sessionId, userId, {
          providerId: adapter.id,
          model: requestedModel,
        });
        if (updated?.providerId && updated?.model) {
          session = updated as Session & {
            providerId: string;
            model: string;
          };
        }
      } else {
        session = raw as Session & { providerId: string; model: string };
      }
    } catch (err) {
      req.log.warn(
        { err, sessionId },
        "session load failed — proceeding without session",
      );
    }

    let scope = metadata?.scope?.length
      ? metadata.scope
      : (session?.activeScope ?? []);

    const turnId = randomUUID();
    const rawContent: string | ContentPart[] = messages.at(-1)?.content ?? "";
    const latestUserMessage = extractLatestUserText(messages);

    const cfg = await deps.runtimeStore.load().catch(() => ({
      extraction_enabled: true,
      injection_enabled: true,
      managed_history_token_cap: 120000,
      compaction_mode: "aggressive" as const,
      scope_auto_detect: true,
    }));

    const client = parseClient(req.headers["user-agent"] as string | undefined);

    const intercepted = await tryInterceptScopeCommand(
      typeof rawContent === "string" ? rawContent : extractText(rawContent),
      sessionId,
      userId,
      deps,
      req.log,
    );

    if (intercepted) {
      if (tierWarning) reply.header("x-tenure-warning", tierWarning);
      return reply.send({
        id: `chatcmpl-${turnId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: intercepted.message,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        tenure: {
          session_id: sessionId,
          turn_id: turnId,
          scope: intercepted.newScope,
          parse_status: "missing",
          degraded: false,
          context: { beliefs: 0, questions: 0, compacted_turns: 0 },
        },
      });
    }

    const extractIntercepted = await tryInterceptExtractCommand(
      typeof rawContent === "string" ? rawContent : extractText(rawContent),
      sessionId,
      userId,
      { sessions: deps.sessions, runtimeStore: deps.runtimeStore },
      req.log,
    );

    if (extractIntercepted) {
      if (tierWarning) reply.header("x-tenure-warning", tierWarning);
      return reply.send({
        id: `chatcmpl-${turnId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: extractIntercepted.message,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        tenure: {
          session_id: sessionId,
          turn_id: turnId,
          scope,
          parse_status: "missing",
          degraded: false,
          context: { beliefs: 0, questions: 0, compacted_turns: 0 },
        },
      });
    }

    const injectIntercepted = await tryInterceptInjectCommand(
      typeof rawContent === "string" ? rawContent : extractText(rawContent),
      sessionId,
      userId,
      { sessions: deps.sessions, runtimeStore: deps.runtimeStore },
      req.log,
    );

    if (injectIntercepted) {
      if (tierWarning) reply.header("x-tenure-warning", tierWarning);
      return reply.send({
        id: `chatcmpl-${turnId}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: injectIntercepted.message },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        tenure: {
          session_id: sessionId,
          turn_id: turnId,
          scope,
          parse_status: "missing",
          degraded: false,
          context: { beliefs: 0, questions: 0, compacted_turns: 0 },
        },
      });
    }

    const isFirstTurn =
      (session?.turnCounter ?? 0) === 0 &&
      scope.length === 0 &&
      deps.scopeDetector != null &&
      cfg.scope_auto_detect !== false;

    if (isFirstTurn && deps.scopeDetector) {
      try {
        const existingScopes = await fetchExistingUserScopes(
          userId,
          deps.scopeDetector.db,
        );
        const detected = await detectScopeFromMessage(
          latestUserMessage,
          existingScopes,
          deps.scopeDetector,
          req.log,
        );
        if (detected.length > 0) {
          await deps.sessions
            .update(sessionId, userId, { activeScope: detected })
            .catch((err) =>
              req.log.warn(
                { err, sessionId },
                "first-turn scope persist failed",
              ),
            );
          scope = detected;
        }
      } catch (err) {
        req.log.warn(
          { err, sessionId },
          "first-turn scope detection failed — proceeding without scope",
        );
      }
    }

    const noExtractHeader =
      req.headers["x-tenure-no-extract"] === "true" ||
      req.headers["x-tenure-no-extract"] === "1";

    const extractionEnabled =
      cfg.extraction_enabled !== false &&
      session?.extractionPaused !== true &&
      !client.isIde &&
      !noExtractHeader;

    const injectionEnabled =
      cfg.injection_enabled !== false &&
      session?.injectionPaused !== true &&
      !client.isIde;

    const [beliefCtx] = await Promise.all([
      injectionEnabled
        ? deps.context.build(userId, scope, latestUserMessage).catch((err) => {
            req.log.warn({ err }, "context assembly failed");
            return EMPTY_CONTEXT;
          })
        : Promise.resolve(EMPTY_CONTEXT),
    ]);

    let systemPrompt: SystemPrompt;

    const incomingSystem = messages.find((m) => m.role === "system")?.content;
    const incomingSystemText =
      incomingSystem === undefined
        ? undefined
        : typeof incomingSystem === "string"
          ? incomingSystem
          : extractText(incomingSystem);

    try {
      systemPrompt = buildSystemPrompt({
        incomingSystem: incomingSystemText,
        beliefCtx,
        extractionEnabled,
        injectionEnabled,
        activeScope: scope[0],
        scopeAutoDetect: cfg.scope_auto_detect !== false,
      });
    } catch (err) {
      req.log.error(
        { err },
        "system prompt build failed — falling back to raw",
      );
      const fallback = messages.find((m) => m.role === "system")?.content ?? "";
      systemPrompt = typeof fallback === "string" ? fallback : "";
    }

    const conversationMessages: Message[] = [
      ...messages
        .filter(
          (m): m is typeof m & { role: "user" | "assistant" } =>
            m.role === "user" || m.role === "assistant",
        )
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const normalizedReq = {
      model: requestedModel,
      messages: conversationMessages,
      ...(temperature !== undefined && { temperature }),
      ...(max_tokens !== undefined && { max_tokens }),
      passThrough,
    };

    if (stream && adapter.callStream) {
      return handleStreamingResponse(
        reply,
        adapter as typeof adapter & {
          callStream: NonNullable<ProviderAdapter["callStream"]>;
        },
        normalizedReq,
        systemPrompt,
        {
          turnId,
          sessionId,
          userId,
          requestedModel,
          latestUserMessage,
          rawContent,
          scope,
          deps,
          session,
          beliefCtx,
          adapter,
          tierWarning,
          logger: req.log,
          extractionEnabled,
          injectionEnabled,
          client,
        },
      );
    }

    let providerResp: NormalizedResponse;
    try {
      providerResp = await adapter.call(normalizedReq, systemPrompt);
    } catch (e) {
      const reason = (e as Error).message;

      deps.errorLogger
        .log({
          severity: "error",
          stage: "provider_call",
          message: reason.slice(0, 500),
          error: e instanceof Error ? e : new Error(reason),
          user_id: userId,
          session_id: sessionId,
          turn_id: turnId,
          provider: adapter.id,
          model: requestedModel,
          user_impacted: true,
          passthrough_succeeded: false,
        })
        .catch(() => {});

      await deps.history
        .appendTurn({
          sessionId,
          userId,
          turnId,
          userMessage: latestUserMessage,
          assistantMessage: "",
          hasBinaryContent: hasBinary(rawContent),
          hasCodeBlock: hasCodeBlock(latestUserMessage),
          turnSignal: "substantive",
          hasOpenQuestion: false,
          hasNewBeliefs: false,
          scope,
          status: "provider_failed",
          failureReason: reason.slice(0, 500),
        })
        .catch((err) =>
          req.log.error(
            { err, sessionId, turnId },
            "provider-failed turn persistence failed",
          ),
        );

      return reply.code(502).send({
        error: { message: (e as Error).message, type: "provider_error" },
      });
    }

    const { visible, sidecarRaw, parseStatus } = splitSidecar(
      providerResp.content ?? "",
    );
    const turnSignal = tryReadTurnSignal(sidecarRaw);

    if (tierWarning) reply.header("x-tenure-warning", tierWarning);

    reply.send({
      id: `chatcmpl-${turnId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: providerResp.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: visible,
            ...(providerResp.toolCalls?.length && {
              tool_calls: providerResp.toolCalls,
            }),
          },
          finish_reason: providerResp.finish_reason,
        },
      ],
      usage: {
        prompt_tokens: providerResp.usage.input_tokens,
        completion_tokens: providerResp.usage.output_tokens,
        total_tokens:
          providerResp.usage.input_tokens + providerResp.usage.output_tokens,
      },
    });

    try {
      runSideEffects({
        deps,
        userId,
        sessionId,
        turnId,
        latestUserMessage,
        visible,
        rawContent,
        sidecarRaw,
        parseStatus,
        scope,
        adapter,
        model: providerResp.model,
        turnSignal,
        session,
        logger: req.log,
        extractionEnabled,
        client,
      });
    } catch (err) {
      req.log.error(
        { err, sessionId, turnId },
        "side effects failed — response still delivered",
      );
    }
  });
}

interface StreamingCtx {
  turnId: string;
  sessionId: string;
  userId: string;
  requestedModel: string;
  latestUserMessage: string;
  rawContent: string | ContentPart[];
  scope: string[];
  deps: ChatDeps;
  session: (Session & { providerId: string; model: string }) | null;
  beliefCtx: BuiltContext;
  adapter: ProviderAdapter;
  tierWarning: string | null;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
  injectionEnabled: boolean;
  client: ParsedClient;
}

async function handleStreamingResponse(
  reply: FastifyReply,
  adapter: ProviderAdapter & {
    callStream: NonNullable<ProviderAdapter["callStream"]>;
  },
  normalizedReq: Parameters<ProviderAdapter["call"]>[0],
  systemPrompt: SystemPrompt,
  ctx: StreamingCtx,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;

  const responseHeaders: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "transfer-encoding": "chunked",
    ...(ctx.tierWarning ? { "x-tenure-warning": ctx.tierWarning } : {}),
  };
  raw.writeHead(200, responseHeaders);

  const sseId = `chatcmpl-${ctx.turnId}`;
  const HOLDBACK = SIDECAR_BEGIN.length;

  let fullContent = "";
  let flushedIdx = 0;
  let sidecarDetected = false;
  let model = ctx.requestedModel;
  let finishReason = "stop";
  let usage = { input_tokens: 0, output_tokens: 0 };

  writeSSE(raw, {
    id: sseId,
    object: "chat.completion.chunk",
    created: ts(),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  });

  const heartbeat = setInterval(() => {
    if (!raw.writableEnded && !clientDisconnected) {
      raw.write(": keep-alive\n\n");
    }
  }, 15_000);

  let clientDisconnected = false;
  raw.on("close", () => {
    clientDisconnected = true;
  });

  try {
    for await (const event of adapter.callStream(normalizedReq, systemPrompt)) {
      if (clientDisconnected) break;
      if (event.type === "content_delta" && event.delta) {
        fullContent += event.delta;

        if (sidecarDetected) continue;

        const markerIdx = fullContent.indexOf(SIDECAR_BEGIN);
        if (markerIdx !== -1) {
          const remaining = fullContent.slice(flushedIdx, markerIdx);
          if (remaining) {
            writeSSE(raw, {
              id: sseId,
              object: "chat.completion.chunk",
              created: ts(),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: remaining },
                  finish_reason: null,
                },
              ],
            });
          }
          flushedIdx = markerIdx;
          sidecarDetected = true;
        } else {
          const safeEnd = fullContent.length - HOLDBACK;
          if (safeEnd > flushedIdx) {
            writeSSE(raw, {
              id: sseId,
              object: "chat.completion.chunk",
              created: ts(),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: fullContent.slice(flushedIdx, safeEnd) },
                  finish_reason: null,
                },
              ],
            });
            flushedIdx = safeEnd;
          }
        }
      }

      if (event.type === "stream_end") {
        if (event.model) model = event.model;
        if (event.finish_reason) finishReason = event.finish_reason;
        if (event.usage) usage = event.usage;
      }
    }
  } catch (err) {
    const message = (err as Error).message;

    ctx.deps.errorLogger
      .log({
        severity: "error",
        stage: "provider_call",
        message: message.slice(0, 500),
        error: err instanceof Error ? err : new Error(message),
        user_id: ctx.userId,
        session_id: ctx.sessionId,
        turn_id: ctx.turnId,
        provider: ctx.adapter.id,
        model: ctx.requestedModel,
        user_impacted: true,
        passthrough_succeeded: false,
      })
      .catch(() => {});

    ctx.logger.error(
      {
        err,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        userId: ctx.userId,
        partialContent: fullContent,
        partialLength: fullContent.length,
      },
      "streaming provider error — no turn persisted",
    );
    writeSSE(raw, {
      error: { message, type: "provider_error" },
    });
    raw.write("data: [DONE]\n\n");
    raw.end();
    return;
  } finally {
    clearInterval(heartbeat);
  }

  if (!sidecarDetected && flushedIdx < fullContent.length) {
    writeSSE(raw, {
      id: sseId,
      object: "chat.completion.chunk",
      created: ts(),
      model,
      choices: [
        {
          index: 0,
          delta: { content: fullContent.slice(flushedIdx) },
          finish_reason: null,
        },
      ],
    });
  }

  writeSSE(raw, {
    id: sseId,
    object: "chat.completion.chunk",
    created: ts(),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.input_tokens + usage.output_tokens,
    },
  });
  raw.write("data: [DONE]\n\n");
  raw.end();

  const { visible, sidecarRaw, parseStatus } = splitSidecar(fullContent);
  const turnSignal = tryReadTurnSignal(sidecarRaw);

  runSideEffects({
    deps: ctx.deps,
    userId: ctx.userId,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    latestUserMessage: ctx.latestUserMessage,
    visible,
    rawContent: ctx.rawContent,
    sidecarRaw,
    parseStatus,
    scope: ctx.scope,
    adapter: ctx.adapter,
    model,
    turnSignal,
    session: ctx.session,
    logger: ctx.logger,
    extractionEnabled: ctx.extractionEnabled,
    client: ctx.client,
  });
}

async function writeSSE(raw: ServerResponse, data: unknown): Promise<void> {
  const ok = raw.write(`data: ${JSON.stringify(data)}\n\n`);
  if (!ok) {
    await new Promise<void>((resolve) => raw.once("drain", resolve));
  }
}

function ts(): number {
  return Math.floor(Date.now() / 1000);
}

interface SideEffectInput {
  deps: ChatDeps;
  userId: string;
  sessionId: string;
  turnId: string;
  latestUserMessage: string;
  visible: string;
  rawContent: string | ContentPart[];
  sidecarRaw: string | null;
  parseStatus: string;
  scope: string[];
  adapter: ProviderAdapter;
  model: string;
  turnSignal: TurnSignal;
  session: (Session & { providerId: string; model: string }) | null;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
  client: ParsedClient;
}

async function runSideEffects(input: SideEffectInput): Promise<void> {
  const flags = readSidecarFlags(input.sidecarRaw);

  try {
    await input.deps.history.appendTurn({
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: input.turnId,
      userMessage: input.latestUserMessage,
      assistantMessage: input.visible,
      hasBinaryContent: hasBinary(input.rawContent),
      hasCodeBlock:
        hasCodeBlock(input.latestUserMessage) || hasCodeBlock(input.visible),
      turnSignal: input.turnSignal,
      hasOpenQuestion: flags.hasOpenQuestion,
      hasNewBeliefs: flags.hasNewBeliefs,
      topics: flags.topicLabel ? [flags.topicLabel] : [],
      scope: input.scope,
    });
  } catch (err) {
    input.logger.error(
      { err, sessionId: input.sessionId, turnId: input.turnId },
      "history append failed — skipping job enqueue to avoid orphaned jobs",
    );
    return;
  }

  if (input.extractionEnabled) {
    try {
      const jobId = await input.deps.jobs.enqueue({
        userId: input.userId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        userMessage: input.latestUserMessage,
        assistantMessage: input.visible,
        sidecarRaw: input.sidecarRaw,
        parseStatus: input.parseStatus as "parsed" | "needs_repair" | "missing",
        scope: input.scope,
        sourceModel: `${input.adapter.id}:${input.model}`,
        clientCategory: input.client.category,
      });
      input.deps.extractionWorker
        .processById(jobId)
        .catch((err) =>
          input.logger.warn(
            { err, jobId, sessionId: input.sessionId },
            "inline extraction failed — sweep will retry",
          ),
        );
    } catch (err) {
      input.logger.error(
        { err, sessionId: input.sessionId, turnId: input.turnId },
        "job enqueue failed — turn persisted but extraction will not run",
      );
    }
  }

  if (input.session) {
    input.deps.sessions
      .touch(input.sessionId, input.userId)
      .catch((err) =>
        input.logger.warn(
          { err, sessionId: input.sessionId },
          "session touch failed",
        ),
      );
  }
}

function extractLatestUserText(
  messages: Array<{ role: string; content: string | ContentPart[] }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      return extractText(content);
    }
  }
  return "";
}

interface BuildSystemPromptArgs {
  incomingSystem: string | undefined;
  beliefCtx: BuiltContext;
  extractionEnabled: boolean;
  injectionEnabled: boolean;
  activeScope: string | undefined;
  scopeAutoDetect: boolean;
}

function buildSystemPrompt(args: BuildSystemPromptArgs): SystemPromptParts {
  const staticParts: string[] = [];

  if (args.extractionEnabled) {
    staticParts.push(
      "You have a secondary task: after your visible response, emit a hidden " +
        "metadata block recording beliefs about this user. While responding, " +
        "note facts the user would be frustrated to re-establish next session: " +
        "their preferences, decisions, project commitments, working principles, " +
        "and how they think and engage. " +
        "Respond fully first; the extraction format follows.",
      buildSidecarInstructions({
        activeScope: args.activeScope,
        scopeAutoDetect: args.scopeAutoDetect,
      }),
    );
  }

  if (args.injectionEnabled) {
    if (args.beliefCtx.personaPrelude) {
      staticParts.push(
        "<persona>",
        args.beliefCtx.personaPrelude,
        "</persona>",
      );
    }

    staticParts.push(
      [
        "You have persistent memory of this user.",
        "The <persona> block above describes who they are and how they want to be engaged — standing context, not facts to quote.",
        "",
        "<pinned_facts> are standing constraints — treat them as hard requirements that shape every answer.",
        "<relevant_beliefs> are query-surfaced context — use them to disambiguate and inform, not as hard constraints.",
        "",
        "For each belief, the why_it_matters field is the primary action directive: it tells you what to change in your response.",
        "Beliefs with epistemic_status 'inferred' are system hypotheses — hold them loosely.",
        "Beliefs with epistemic_status 'exploratory' are unresolved — do not treat them as settled.",
        "Beliefs with confidence below 0.65 are low-certainty — weight them accordingly.",
        "Treat open questions as unresolved; do not invent closure.",
      ].join("\n"),
    );
  }

  const staticSection = staticParts.join("\n\n");

  const beliefsSection = args.injectionEnabled
    ? [
        "<pinned_facts>",
        args.beliefCtx.pinnedFactsJson,
        "</pinned_facts>",
      ].join("\n")
    : "";

  const dynamicParts: string[] = [];

  if (args.injectionEnabled) {
    dynamicParts.push(
      [
        "<relevant_beliefs>",
        args.beliefCtx.relevantBeliefsJson,
        "</relevant_beliefs>",
        "",
        "### Open Questions",
        args.beliefCtx.openQuestionsJson,
      ].join("\n"),
    );
  }

  if (args.incomingSystem) {
    dynamicParts.push(args.incomingSystem.trim());
  }

  dynamicParts.push(
    args.extractionEnabled
      ? "--- Respond to the user's message. After your complete, visible response, append the sidecar block. ---"
      : "--- Respond to the user's message. ---",
  );

  return {
    static: staticSection,
    beliefs: beliefsSection,
    dynamic: dynamicParts.join("\n\n"),
  };
}

function tryReadTurnSignal(sidecarRaw: string | null): TurnSignal {
  if (!sidecarRaw) return "substantive";
  try {
    const parsed = JSON.parse(sidecarRaw) as { turn_signal?: TurnSignal };
    const s = parsed.turn_signal;
    if (
      s === "substantive" ||
      s === "acknowledgment" ||
      s === "clarification" ||
      s === "correction"
    ) {
      return s;
    }
  } catch {
    /* malformed — worker will repair */
  }
  return "substantive";
}

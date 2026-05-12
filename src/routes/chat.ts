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
  Message,
  NormalizedResponse,
  ProviderAdapter,
  SystemPrompt,
  SystemPromptParts,
} from "../providers/types.ts";
import { hasBinary, hasCodeBlock } from "../helpers/content.js";
import { deriveSessionId } from "../session/derivation.js";
import { checkModelTier, listSupportedFamilies } from "../providers/tiers.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { EMPTY_RENDERED } from "../history/compaction.js";
import {
  tryInterceptScopeCommand,
  detectScopeFromMessage,
  fetchExistingUserScopes,
  type ScopeDetectorDeps,
} from "../helpers/scopeDetector.js";
import type { ErrorLogger } from "../errors/logger.js";

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
  messages: Array<{ role: string; content: string; name?: string }>;
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
    const rawContent = messages.at(-1)?.content ?? "";
    const latestUserMessage = extractLatestUserMessage(messages);

    const cfg = await deps.runtimeStore.load().catch(() => ({
      extraction_enabled: true,
      managed_history_token_cap: 120000,
      compaction_mode: "aggressive" as const,
      scope_auto_detect: true,
    }));

    const intercepted = await tryInterceptScopeCommand(
      rawContent,
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

    const [beliefCtx, rendered] = await Promise.all([
      deps.context.build(userId, scope, latestUserMessage).catch((err) => {
        req.log.warn({ err }, "context assembly failed");
        return EMPTY_CONTEXT;
      }),
      deps.history
        .renderCompacted(sessionId, cfg.managed_history_token_cap, {
          compactionMode: cfg.compaction_mode,
        })
        .catch(() => EMPTY_RENDERED),
      deps.runtimeStore.load().catch(() => ({ extraction_enabled: true })),
    ]);

    const extractionEnabled = cfg.extraction_enabled !== false;

    let systemPrompt: SystemPrompt;
    try {
      systemPrompt = buildSystemPrompt({
        incomingSystem: messages.find((m) => m.role === "system")?.content,
        beliefCtx,
        extractionEnabled,
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
      ...rendered.messages,
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
    const degraded = session === null || beliefCtx === EMPTY_CONTEXT;

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
      tenure: {
        session_id: sessionId,
        turn_id: turnId,
        scope,
        parse_status: parseStatus,
        degraded,
        context: {
          beliefs: beliefCtx.beliefCount,
          questions: beliefCtx.questionCount,
          compacted_turns: rendered.turnsCollapsed,
        },
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
  rawContent: string;
  scope: string[];
  deps: ChatDeps;
  session: (Session & { providerId: string; model: string }) | null;
  beliefCtx: BuiltContext;
  adapter: ProviderAdapter;
  tierWarning: string | null;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
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
  rawContent: string;
  sidecarRaw: string | null;
  parseStatus: string;
  scope: string[];
  adapter: ProviderAdapter;
  model: string;
  turnSignal: TurnSignal;
  session: (Session & { providerId: string; model: string }) | null;
  logger: FastifyBaseLogger;
  extractionEnabled: boolean;
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

function extractLatestUserMessage(
  messages: Array<{ role: string; content: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

interface BuildSystemPromptArgs {
  incomingSystem: string | undefined;
  beliefCtx: BuiltContext;
  extractionEnabled: boolean;
  activeScope: string | undefined;
  scopeAutoDetect: boolean;
}

function buildSystemPrompt(args: BuildSystemPromptArgs): SystemPromptParts {
  const staticSection = args.extractionEnabled
    ? [
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
      ].join("\n\n")
    : "";

  const stableBeliefLines: string[] = [
    "You have persistent memory of this user.",
    "The <persona> block describes who they are and how they want to be engaged — standing context, not facts to quote.",
    "The <scope> block narrows that persona to the current domain.",
    "",
    "<pinned_facts> are standing constraints — treat them as hard requirements that shape every answer.",
    "<relevant_beliefs> are query-surfaced context — use them to disambiguate and inform, not as hard constraints.",
    "",
    "For each belief, the why_it_matters field is the primary action directive: it tells you what to change in your response.",
    "Beliefs with epistemic_status 'inferred' are system hypotheses — hold them loosely.",
    "Beliefs with epistemic_status 'exploratory' are unresolved — do not treat them as settled.",
    "Beliefs with confidence below 0.65 are low-certainty — weight them accordingly.",
    "Treat open questions as unresolved; do not invent closure.",
  ];

  if (args.beliefCtx.personaPrelude) {
    stableBeliefLines.push(
      "<persona>",
      args.beliefCtx.personaPrelude,
      "</persona>",
      "",
    );
  }

  stableBeliefLines.push(
    "<pinned_facts>",
    args.beliefCtx.pinnedFactsJson,
    "</pinned_facts>",
  );

  const beliefsSection = stableBeliefLines.join("\n");

  const dynamicBeliefLines: string[] = [
    "<relevant_beliefs>",
    args.beliefCtx.relevantBeliefsJson,
    "</relevant_beliefs>",
    "",
    "### Open Questions",
    args.beliefCtx.openQuestionsJson,
  ];

  const dynamicParts: string[] = [];

  dynamicParts.push(dynamicBeliefLines.join("\n"));

  if (args.incomingSystem) {
    dynamicParts.push(args.incomingSystem.trim());
  }

  dynamicParts.push(
    args.extractionEnabled
      ? "--- Respond to the user's message. After your complete, visible response, append the sidecar block. ---"
      : "--- Respond to the user's message. ---",
  );

  const dynamicSection = dynamicParts.join("\n\n");

  return {
    static: staticSection,
    beliefs: beliefsSection,
    dynamic: dynamicSection,
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

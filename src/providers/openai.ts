import {
  flattenSystemPrompt,
  type ContentPart,
  type Message,
  type ModelInfo,
  type NormalizedRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type StreamEvent,
  type SystemPrompt,
} from "./types.js";
import type { OpenAIEndpointFlavor } from "../config/runtime.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly id = "openai" as const;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl?: string,
    private readonly flavor: OpenAIEndpointFlavor = "generic",
  ) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async call(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): Promise<NormalizedResponse> {
    if (!req.model) {
      throw new Error(
        "No model specified — select a model in your client settings.",
      );
    }

    const { messages, body: extraBody } = this.composeRequest(
      req,
      systemPrompt,
    );
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: false,
        ...extraBody,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new ProviderError(`openai ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as {
      model: string;
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: OAIToolCall[];
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
      };
    };

    if (!data.choices?.length) {
      throw new ProviderError("openai: empty choices in response");
    }

    const choice = data.choices[0];
    const toolCalls = choice.message.tool_calls;

    return {
      content: choice.message.content ?? "",
      model: data.model,
      provider: "openai",
      finish_reason: choice.finish_reason,
      usage: {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      },
      ...(toolCalls?.length ? { toolCalls } : {}),
    };
  }

  async *callStream(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): AsyncGenerator<StreamEvent> {
    if (!req.model) {
      throw new Error(
        "No model specified — select a model in your client settings.",
      );
    }

    const { messages, body: extraBody } = this.composeRequest(
      req,
      systemPrompt,
    );
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        messages,
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        stream: true,
        stream_options: { include_usage: true },
        ...extraBody,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new ProviderError(`openai ${res.status}: ${await res.text()}`);
    }

    if (!res.body) {
      throw new ProviderError("openai: empty stream body");
    }

    let model = req.model;
    let finishReason = "stop";
    let usage = { input_tokens: 0, output_tokens: 0 };

    const toolCallAccumulator: Record<
      number,
      { id: string; name: string; arguments: string }
    > = {};

    for await (const line of sseLines(res.body)) {
      if (line === "[DONE]") break;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof data.model === "string") model = data.model;

      const choices = data.choices as
        | Array<{
            delta?: { content?: string; tool_calls?: OAIToolCallDelta[] };
            finish_reason?: string;
          }>
        | undefined;

      const choice = choices?.[0];

      if (choice?.delta?.content) {
        yield { type: "content_delta", delta: choice.delta.content };
      }

      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (!toolCallAccumulator[tc.index]) {
            toolCallAccumulator[tc.index] = { id: "", name: "", arguments: "" };
          }
          const acc = toolCallAccumulator[tc.index];
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const u = data.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      if (u) {
        usage = {
          input_tokens: u.prompt_tokens ?? 0,
          output_tokens: u.completion_tokens ?? 0,
        };
      }
    }

    const toolCalls = Object.values(toolCallAccumulator);

    yield {
      type: "stream_end",
      model,
      finish_reason: finishReason,
      usage,
      ...(toolCalls.length
        ? {
            toolCalls: toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            })),
          }
        : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 401) {
        throw new ProviderError(
          "OpenAI authentication failed — check your API key in the admin UI",
        );
      }
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: ModelInfo[] };
      return (data.data ?? []).map((m) => ({
        id: m.id,
        object: "model" as const,
        created: m.created ?? 0,
        owned_by: m.owned_by ?? this.id,
      }));
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      return [];
    }
  }

  /**
   * Compose the messages array and any extra top-level body fields needed
   * for the configured flavor.
   *
   * Flavor behaviour:
   *
   * "bedrock-access-gateway"
   *   BAG translates a top-level `prompt_caching` field into Bedrock
   *   cachePoint blocks internally. We request caching on both system and
   *   messages so all three tiers (static, beliefs, dynamic) are covered.
   *   The system prompt is flattened to a plain string — BAG handles the
   *   cache segmentation itself based on token boundaries.
   *
   * "litellm"
   *   LiteLLM accepts Anthropic-style cache_control markers and translates
   *   them to Bedrock cachePoint blocks. We pass the system prompt as a
   *   content array with ephemeral markers on the static and beliefs tiers,
   *   matching what the Anthropic adapter does natively.
   *
   * "generic" / null
   *   Plain OpenAI — no caching hints, flat system string.
   */
  private composeRequest(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): { messages: Message[]; body: Record<string, unknown> } {
    switch (this.flavor) {
      case "bedrock-access-gateway":
        return this.composeForBAG(req, systemPrompt);
      case "litellm":
        return this.composeForLiteLLM(req, systemPrompt);
      default:
        return this.composeGeneric(req, systemPrompt);
    }
  }

  private composeGeneric(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): { messages: Message[]; body: Record<string, unknown> } {
    const flat =
      typeof systemPrompt === "string"
        ? systemPrompt
        : flattenSystemPrompt(systemPrompt);
    return { messages: this.mergeSystemPrompt(req.messages, flat), body: {} };
  }

  // ── Bedrock Access Gateway ──────────────────────────────────────────────
  //
  // BAG exposes prompt caching via a top-level extra_body field.
  // The system prompt is sent as a flat string; BAG manages the cache
  // segmentation itself via its ENABLE_PROMPT_CACHING flag or per-request
  // prompt_caching param. We request both system and messages caching.

  private composeForBAG(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): { messages: Message[]; body: Record<string, unknown> } {
    const flat =
      typeof systemPrompt === "string"
        ? systemPrompt
        : flattenSystemPrompt(systemPrompt);
    return {
      messages: this.mergeSystemPrompt(req.messages, flat),
      body: {
        prompt_caching: { system: true, messages: true },
      },
    };
  }

  // ── LiteLLM ─────────────────────────────────────────────────────────────
  //
  // LiteLLM accepts Anthropic-style cache_control on system content blocks
  // and translates them to Bedrock cachePoint blocks downstream.
  // We replicate the three-tier segmentation from the Anthropic adapter:
  //   - static tier  → cache_control: ephemeral
  //   - beliefs tier → cache_control: ephemeral
  //   - dynamic tier → no cache marker
  //
  // When a legacy string prompt is passed we treat the whole thing as static.

  private composeForLiteLLM(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): { messages: Message[]; body: Record<string, unknown> } {
    const existingSystem = extractSystemText(req.messages);
    const rest = req.messages.filter((m) => m.role !== "system");

    let systemContent: unknown;

    if (typeof systemPrompt === "string") {
      const merged = [systemPrompt, existingSystem]
        .filter(Boolean)
        .join("\n\n");
      systemContent = merged
        ? [{ type: "text", text: merged, cache_control: { type: "ephemeral" } }]
        : undefined;
    } else {
      const blocks: unknown[] = [];

      if (systemPrompt.static) {
        blocks.push({
          type: "text",
          text: systemPrompt.static,
          cache_control: { type: "ephemeral" },
        });
      }

      const beliefText = [systemPrompt.beliefs, existingSystem]
        .filter(Boolean)
        .join("\n\n");
      if (beliefText) {
        blocks.push({
          type: "text",
          text: beliefText,
          cache_control: { type: "ephemeral" },
        });
      }

      if (systemPrompt.dynamic) {
        blocks.push({ type: "text", text: systemPrompt.dynamic });
      }

      systemContent = blocks.length > 0 ? blocks : undefined;
    }

    const messages: Message[] = systemContent
      ? [
          {
            role: "system" as const,
            content: systemContent as ContentPart[],
          },
          ...rest,
        ]
      : rest;

    return { messages, body: {} };
  }

  private mergeSystemPrompt(incoming: Message[], injected: string): Message[] {
    const sys = incoming.find((m) => m.role === "system");
    // content can be a ContentPart[] — extract text safely to avoid
    // "[object Object]" appearing in the merged system prompt.
    const existingSystem = sys
      ? typeof sys.content === "string"
        ? sys.content
        : (sys.content as ContentPart[])
            .filter(
              (p): p is { type: "text"; text: string } => p.type === "text",
            )
            .map((p) => p.text)
            .join("\n")
      : "";
    const rest = incoming.filter((m) => m.role !== "system");
    const merged = [injected, existingSystem].filter(Boolean).join("\n\n");
    return merged ? [{ role: "system", content: merged }, ...rest] : rest;
  }
}

function extractSystemText(messages: Message[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string" ? sys.content : "";
}

async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed.startsWith("data: ")) continue;
        yield trimmed.slice(6);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class ProviderError extends Error {}

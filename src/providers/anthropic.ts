import Anthropic from "@anthropic-ai/sdk";
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
  StreamEvent,
  ModelInfo,
  Message,
  ContentPart,
  TextPart,
  SystemPrompt,
} from "./types.ts";

interface OAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}
type OAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async call(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): Promise<NormalizedResponse> {
    const base = this.buildCallParams(req, systemPrompt);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        ...base,
        stream: false as const,
      });
    } catch (e) {
      throw mapError(e);
    }

    const { text, toolCalls } = extractResponseParts(response.content);

    return {
      content: text,
      model: response.model,
      provider: "anthropic",
      finish_reason: mapStopReason(response.stop_reason),
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      ...(toolCalls.length && { toolCalls }),
    };
  }

  async *callStream(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): AsyncGenerator<StreamEvent> {
    const base = this.buildCallParams(req, systemPrompt);
    const stream = this.client.messages.stream(base);

    try {
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { type: "content_delta", delta: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      yield {
        type: "stream_end",
        model: final.model,
        finish_reason: mapStopReason(final.stop_reason),
        usage: {
          input_tokens: final.usage.input_tokens,
          output_tokens: final.usage.output_tokens,
        },
      };
    } catch (e) {
      throw mapError(e);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const page = await this.client.models.list({ limit: 100 });
      return page.data.map((m) => ({
        id: m.id,
        object: "model" as const,
        created: Math.floor(new Date(m.created_at).getTime() / 1000),
        owned_by: "anthropic",
      }));
    } catch {
      return [];
    }
  }

  private buildCallParams(req: NormalizedRequest, systemPrompt: SystemPrompt) {
    const existingSystem = extractSystemText(req.messages);

    let system: string | Anthropic.TextBlockParam[] | undefined;

    if (typeof systemPrompt === "string") {
      system =
        [systemPrompt, existingSystem].filter(Boolean).join("\n\n") ||
        undefined;
    } else {
      const blocks: Anthropic.TextBlockParam[] = [];

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
        blocks.push({
          type: "text",
          text: systemPrompt.dynamic,
        });
      }

      system = blocks.length > 0 ? blocks : undefined;
    }

    const conversation = req.messages
      .filter((m) => m.role !== "system")
      .map(toAnthropicMessage);

    const pt = req.passThrough ?? {};
    const tools = translateTools(pt.tools as OAIFunctionTool[] | undefined);
    const toolChoice = translateToolChoice(
      pt.tool_choice as OAIToolChoice | undefined,
      tools,
    );

    return {
      model: req.model,
      messages: conversation,
      max_tokens: req.max_tokens ?? 4096,
      cache_control: { type: "ephemeral" as const },
      ...(system !== undefined ? { system } : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      ...(pt.top_p !== undefined ? { top_p: pt.top_p as number } : {}),
      ...(pt.stop
        ? {
            stop_sequences: Array.isArray(pt.stop)
              ? (pt.stop as string[])
              : [pt.stop as string],
          }
        : {}),
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    };
  }
}

function toAnthropicMessage(msg: Message): Anthropic.MessageParam {
  if (msg.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: msg.tool_call_id ?? "",
          content:
            typeof msg.content === "string"
              ? msg.content
              : textOnly(msg.content),
        },
      ],
    };
  }

  if (msg.role === "assistant" && msg.tool_calls?.length) {
    const blocks: Anthropic.ContentBlockParam[] = [];

    const textContent =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
          ? textOnly(msg.content as ContentPart[])
          : "";
    if (textContent) blocks.push({ type: "text", text: textContent });

    for (const tc of msg.tool_calls as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments),
      });
    }

    return { role: "assistant", content: blocks };
  }

  const role = msg.role as "user" | "assistant";

  if (typeof msg.content === "string") {
    return { role, content: msg.content };
  }

  return { role, content: (msg.content as ContentPart[]).map(toContentBlock) };
}

function toContentBlock(part: ContentPart): Anthropic.ContentBlockParam {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }

  if (part.type === "image_url") {
    const { url } = part.image_url;

    if (url.startsWith("data:")) {
      const [header, data] = url.split(",");
      const rawType = header.split(":")[1]?.split(";")[0] ?? "image/jpeg";
      const mediaType = validateImageMediaType(rawType);
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data },
      };
    }

    return { type: "image", source: { type: "url", url } };
  }

  return { type: "text", text: "[attached file]" };
}

function translateTools(
  tools: OAIFunctionTool[] | undefined,
): Anthropic.Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      ...(t.function.description !== undefined
        ? { description: t.function.description }
        : {}),
      input_schema: (t.function.parameters ?? {
        type: "object",
        properties: {},
      }) as Anthropic.Tool["input_schema"],
    }));
}

function translateToolChoice(
  choice: OAIToolChoice | undefined,
  tools: Anthropic.Tool[] | undefined,
): Anthropic.ToolChoice | undefined {
  if (!choice || !tools?.length) return undefined;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return undefined;
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name };
  }
  return undefined;
}

function extractResponseParts(blocks: Anthropic.ContentBlock[]): {
  text: string;
  toolCalls: unknown[];
} {
  let text = "";
  const toolCalls: unknown[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  return { text, toolCalls };
}

function mapStopReason(reason: string | null): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

function mapError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) {
    return new Error(
      "Anthropic authentication failed — check your API key in the admin UI",
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new Error("Anthropic rate limit exceeded — retry after back-off");
  }
  if (e instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${e.status}: ${e.message}`);
  }
  return e instanceof Error ? e : new Error(String(e));
}

function extractSystemText(messages: Message[]): string {
  const sys = messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string"
    ? sys.content
    : textOnly(sys.content as ContentPart[]);
}

function textOnly(parts: ContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function validateImageMediaType(
  raw: string,
): Anthropic.Base64ImageSource["media_type"] {
  const allowed = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ] as const;
  return (allowed as readonly string[]).includes(raw)
    ? (raw as Anthropic.Base64ImageSource["media_type"])
    : "image/jpeg";
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

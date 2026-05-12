export interface NormalizedRequest {
  model: string;
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  passThrough?: Record<string, unknown>;
}

export interface NormalizedResponse {
  content: string;
  model: string;
  provider: string;
  finish_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  toolCalls?: unknown[];
}

export interface ProviderAdapter {
  readonly id: string;
  call(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): Promise<NormalizedResponse>;
  callStream?(
    req: NormalizedRequest,
    systemPrompt: SystemPrompt,
  ): AsyncIterable<StreamEvent>;
  listModels?(): Promise<ModelInfo[]>;
}

export interface TextPart {
  type: "text";
  text: string;
  cache_control?: { type: string };
}

export interface ImageUrlPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export interface FilePart {
  type: "file";
  file: { url: string; name?: string };
}

export type ContentPart = TextPart | ImageUrlPart | FilePart;

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ModelInfo {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface StreamEvent {
  type: "content_delta" | "stream_end";
  delta?: string;
  model?: string;
  finish_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface SystemPromptParts {
  static: string;
  beliefs: string;
  dynamic: string;
}

export type SystemPrompt = string | SystemPromptParts;

export function flattenSystemPrompt(sp: SystemPrompt): string {
  if (typeof sp === "string") return sp;
  return [sp.static, sp.beliefs, sp.dynamic].filter(Boolean).join("\n\n");
}

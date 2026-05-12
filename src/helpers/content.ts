import type { ContentPart, TextPart } from "../providers/types.js";

export function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function hasBinary(content: string | ContentPart[]): boolean {
  if (typeof content === "string") return false;
  return content.some((p) => p.type === "image_url" || p.type === "file");
}

export function hasCodeBlock(content: string | ContentPart[]): boolean {
  const text = typeof content === "string" ? content : extractText(content);
  return /```[\s\S]*?```/.test(text);
}

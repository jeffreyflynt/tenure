import { createHash, randomUUID } from "node:crypto";
import type { Message } from "../providers/types.js";

export function deriveSessionId(
  messages: Message[],
  userId: string,
  explicit: string | undefined,
): string {
  if (explicit) return explicit;
  if (messages.length <= 1) return randomUUID();

  const prefix = messages.slice(0, Math.min(3, messages.length - 1));
  const hash = createHash("sha256")
    .update(userId)
    .update(
      JSON.stringify(prefix.map((m) => ({ role: m.role, content: m.content }))),
    )
    .digest("hex")
    .slice(0, 24);
  return `derived_${hash}`;
}

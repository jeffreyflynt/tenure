import test from "ava";
import { deriveSessionId } from "./derivation.js";
import type { Message } from "../providers/types.js";

function makeMessages(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `message ${i}`,
  })) as Message[];
}

test("returns explicit id unchanged, regardless of messages", (t) => {
  const msgs = makeMessages(5);
  t.is(deriveSessionId(msgs, "user-1", "my-session"), "my-session");
});

test("returns explicit id even when messages is empty", (t) => {
  t.is(deriveSessionId([], "user-1", "explicit"), "explicit");
});

test("returns a UUID when messages is empty and no explicit id", (t) => {
  const id = deriveSessionId([], "user-1", undefined);
  t.regex(id, /^[0-9a-f-]{36}$/i);
});

test("returns a UUID when there is exactly 1 message", (t) => {
  const id = deriveSessionId(makeMessages(1), "user-1", undefined);
  t.regex(id, /^[0-9a-f-]{36}$/i);
});

test("UUID is different on every call for 0-message case", (t) => {
  const a = deriveSessionId([], "user-1", undefined);
  const b = deriveSessionId([], "user-1", undefined);
  t.not(a, b);
});

test("returns a derived_ id when there are 2 or more messages", (t) => {
  const id = deriveSessionId(makeMessages(2), "user-1", undefined);
  t.true(id.startsWith("derived_"));
});

test("derived id is deterministic for same input", (t) => {
  const msgs = makeMessages(4);
  const a = deriveSessionId(msgs, "user-1", undefined);
  const b = deriveSessionId(msgs, "user-1", undefined);
  t.is(a, b);
});

test("derived id differs when userId changes", (t) => {
  const msgs = makeMessages(4);
  const a = deriveSessionId(msgs, "user-1", undefined);
  const b = deriveSessionId(msgs, "user-2", undefined);
  t.not(a, b);
});

test("derived id differs when prefix messages change", (t) => {
  const msgs1 = makeMessages(4);
  const msgs2 = makeMessages(4);
  msgs2[0] = { role: "user", content: "completely different" } as Message;
  const a = deriveSessionId(msgs1, "user-1", undefined);
  const b = deriveSessionId(msgs2, "user-1", undefined);
  t.not(a, b);
});

test("derived id is stable regardless of messages beyond position 3", (t) => {
  const base = makeMessages(4);
  const withExtra = [
    ...base.slice(0, 4),
    { role: "user", content: "extra" } as Message,
    { role: "assistant", content: "extra reply" } as Message,
  ];
  const a = deriveSessionId(base, "user-1", undefined);
  const b = deriveSessionId(withExtra, "user-1", undefined);
  t.is(a, b);
});

test("derived id hex portion is exactly 24 chars", (t) => {
  const id = deriveSessionId(makeMessages(3), "user-1", undefined);
  const hex = id.replace("derived_", "");
  t.is(hex.length, 24);
});

test("explicit id takes precedence over 2+ messages that would derive", (t) => {
  const msgs = makeMessages(5);
  const id = deriveSessionId(msgs, "user-1", "override");
  t.is(id, "override");
});

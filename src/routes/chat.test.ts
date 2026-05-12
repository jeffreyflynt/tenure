import test from "ava";
import {
  SIDECAR_BEGIN,
  SIDECAR_END,
  splitSidecar,
} from "../sidecar/splitter.js";

function extractLatestUserMessage(
  messages: Array<{ role: string; content: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

test("extractLatestUserMessage returns the last user message", (t) => {
  const msgs = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ];
  t.is(extractLatestUserMessage(msgs), "second");
});

test("extractLatestUserMessage skips trailing assistant messages", (t) => {
  const msgs = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "world" },
  ];
  t.is(extractLatestUserMessage(msgs), "hello");
});

test("extractLatestUserMessage returns empty string when no user messages", (t) => {
  const msgs = [{ role: "assistant", content: "I'll start" }];
  t.is(extractLatestUserMessage(msgs), "");
});

test("extractLatestUserMessage returns empty string for empty array", (t) => {
  t.is(extractLatestUserMessage([]), "");
});

test("extractLatestUserMessage handles single user message", (t) => {
  t.is(
    extractLatestUserMessage([{ role: "user", content: "only one" }]),
    "only one",
  );
});

import type { TurnSignal } from "../history/manager.js";

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
  } catch {}
  return "substantive";
}

test("tryReadTurnSignal returns substantive for null", (t) => {
  t.is(tryReadTurnSignal(null), "substantive");
});

test("tryReadTurnSignal parses substantive", (t) => {
  t.is(tryReadTurnSignal('{"turn_signal":"substantive"}'), "substantive");
});

test("tryReadTurnSignal parses acknowledgment", (t) => {
  t.is(tryReadTurnSignal('{"turn_signal":"acknowledgment"}'), "acknowledgment");
});

test("tryReadTurnSignal parses clarification", (t) => {
  t.is(tryReadTurnSignal('{"turn_signal":"clarification"}'), "clarification");
});

test("tryReadTurnSignal parses correction", (t) => {
  t.is(tryReadTurnSignal('{"turn_signal":"correction"}'), "correction");
});

test("tryReadTurnSignal falls back to substantive for unknown signal value", (t) => {
  t.is(tryReadTurnSignal('{"turn_signal":"unknown_value"}'), "substantive");
});

test("tryReadTurnSignal falls back to substantive for missing turn_signal key", (t) => {
  t.is(tryReadTurnSignal('{"other_key":"value"}'), "substantive");
});

test("tryReadTurnSignal falls back to substantive for malformed JSON", (t) => {
  t.is(tryReadTurnSignal("{not valid json}"), "substantive");
});

test("tryReadTurnSignal falls back to substantive for empty string", (t) => {
  t.is(tryReadTurnSignal(""), "substantive");
});

test("sidecar round-trip: split then read turn signal", (t) => {
  const payload = '{"turn_signal":"clarification","new_beliefs":[]}';
  const raw = `Visible response.\n${SIDECAR_BEGIN}\n${payload}\n${SIDECAR_END}`;
  const { sidecarRaw } = splitSidecar(raw);
  t.is(tryReadTurnSignal(sidecarRaw), "clarification");
});

test("sidecar round-trip: missing sidecar yields substantive", (t) => {
  const { sidecarRaw } = splitSidecar("Just a plain response with no sidecar.");
  t.is(tryReadTurnSignal(sidecarRaw), "substantive");
});

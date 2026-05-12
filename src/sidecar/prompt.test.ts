import test from "ava";
import { buildSidecarInstructions } from "./prompt.js";
import { SIDECAR_BEGIN, SIDECAR_END } from "./splitter.js";

test("output contains the SIDECAR_BEGIN marker", (t) => {
  const out = buildSidecarInstructions();
  t.true(out.includes(SIDECAR_BEGIN));
});

test("output contains the SIDECAR_END marker", (t) => {
  const out = buildSidecarInstructions();
  t.true(out.includes(SIDECAR_END));
});

test("output is a non-empty trimmed string", (t) => {
  const out = buildSidecarInstructions();
  t.is(out, out.trim());
  t.true(out.length > 0);
});

test("output includes turn_signal schema documentation", (t) => {
  const out = buildSidecarInstructions();
  t.true(out.includes("turn_signal"));
});

test("output mentions the omit rule for unclear beliefs", (t) => {
  const out = buildSidecarInstructions();
  t.true(out.includes("If you cannot write it clearly, omit the belief."));
});

test("works with empty beliefs and questions arrays", (t) => {
  const out = buildSidecarInstructions();
  t.true(out.includes(SIDECAR_BEGIN));
  t.true(out.includes("[]"));
});

test("SIDECAR_BEGIN appears before SIDECAR_END in the output", (t) => {
  const out = buildSidecarInstructions();
  t.true(out.indexOf(SIDECAR_BEGIN) < out.indexOf(SIDECAR_END));
});

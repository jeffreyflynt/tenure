import test from "ava";
import { ProviderRegistry, ProviderNotConfiguredError } from "./registry.js";
import type { ProviderAdapter, NormalizedResponse } from "./types.js";

const noop = async (): Promise<NormalizedResponse> =>
  ({}) as NormalizedResponse;
const makeAdapter = (id: string): ProviderAdapter => ({ id, call: noop });

test("register() + resolve() round-trips the same instance", (t) => {
  const registry = new ProviderRegistry();
  const adapter = makeAdapter("openai");
  registry.register(adapter);
  t.is(registry.resolve("openai"), adapter);
});

test("register() is chainable", (t) => {
  const registry = new ProviderRegistry();
  t.is(registry.register(makeAdapter("a")), registry);
});

test("resolve() throws ProviderNotConfiguredError for unknown id", (t) => {
  const registry = new ProviderRegistry();
  const err = t.throws(() => registry.resolve("ghost"), {
    instanceOf: ProviderNotConfiguredError,
  });
  t.is(err?.provider, "ghost");
});

test("ProviderNotConfiguredError message contains provider id", (t) => {
  t.regex(new ProviderNotConfiguredError("bedrock").message, /bedrock/);
});

const detectMacro = test.macro<[model: string, expectedId: string]>(
  (t, model, expectedId) => {
    const registry = new ProviderRegistry();
    ["anthropic", "openai", "bedrock", "custom"].forEach((id) =>
      registry.register(makeAdapter(id)),
    );
    t.is(registry.detectFromModel(model, "custom").id, expectedId);
  },
);

test(
  "detectFromModel: claude-* → anthropic",
  detectMacro,
  "claude-3-5-sonnet",
  "anthropic",
);
test(
  "detectFromModel: anthropic.* → anthropic",
  detectMacro,
  "anthropic.claude-v2",
  "anthropic",
);
test("detectFromModel: gpt-* → openai", detectMacro, "gpt-4o", "openai");
test("detectFromModel: o1-* → openai", detectMacro, "o1-preview", "openai");
test("detectFromModel: o3-* → openai", detectMacro, "o3-mini", "openai");
test(
  "detectFromModel: amazon.* → bedrock",
  detectMacro,
  "amazon.titan-text",
  "bedrock",
);
test(
  "detectFromModel: unknown uses fallback",
  detectMacro,
  "llama-3",
  "custom",
);

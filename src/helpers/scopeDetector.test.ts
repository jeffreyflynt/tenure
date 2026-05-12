import test from "ava";
import sinon from "sinon";
import type { Db, Collection } from "mongodb";
import {
  matchScopeCommand,
  tryInterceptScopeCommand,
  detectScopeFromMessage,
  fetchExistingUserScopes,
  type ScopeDetectorDeps,
  expandScopeHierarchy,
} from "./scopeDetector.js";

test("matchScopeCommand returns null for a regular message", (t) => {
  t.is(matchScopeCommand("what is Redis?"), null);
});

test("matchScopeCommand returns null for empty string", (t) => {
  t.is(matchScopeCommand(""), null);
});

test("matchScopeCommand matches !scope prefix", (t) => {
  t.is(matchScopeCommand("!scope domain:code"), "domain:code");
});

test("matchScopeCommand matches !scope prefix case-insensitively", (t) => {
  t.is(matchScopeCommand("!SCOPE domain:code"), "domain:code");
});

test("matchScopeCommand matches 'set scope' prefix", (t) => {
  t.is(matchScopeCommand("set scope domain:writing"), "domain:writing");
});

test("matchScopeCommand matches 'set scope' prefix case-insensitively", (t) => {
  t.is(matchScopeCommand("SET SCOPE domain:writing"), "domain:writing");
});

test("matchScopeCommand returns empty string for !scope with no argument", (t) => {
  t.is(matchScopeCommand("!scope"), "");
});

test("matchScopeCommand returns empty string for !scope with only whitespace", (t) => {
  t.is(matchScopeCommand("!scope   "), "");
});

test("matchScopeCommand trims the extracted value", (t) => {
  t.is(matchScopeCommand("!scope   domain:code   "), "domain:code");
});

test("matchScopeCommand returns multiple scopes as raw string", (t) => {
  t.is(
    matchScopeCommand("!scope domain:code domain:writing"),
    "domain:code domain:writing",
  );
});

test("matchScopeCommand returns null when prefix appears mid-message", (t) => {
  t.is(matchScopeCommand("please !scope domain:code for me"), null);
});

function makeSessionsDep(updateFn?: sinon.SinonStub) {
  return {
    sessions: {
      update: updateFn ?? sinon.stub().resolves({ activeScope: [] }),
    },
  };
}

const NOOP_LOGGER = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => NOOP_LOGGER,
} as any;

test("tryInterceptScopeCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptScopeCommand(
    "what is Redis?",
    "session-1",
    "user-1",
    makeSessionsDep(),
    NOOP_LOGGER,
  );
  t.is(result, null);
});

test("tryInterceptScopeCommand returns usage message for !scope with no argument", async (t) => {
  const result = await tryInterceptScopeCommand(
    "!scope",
    "session-1",
    "user-1",
    makeSessionsDep(),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.includes("No scope provided"));
  t.deepEqual(result!.newScope, []);
});

test("tryInterceptScopeCommand updates session and returns acknowledgment", async (t) => {
  const update = sinon.stub().resolves({ activeScope: ["domain:code"] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["domain:code"]);
  t.true(result!.message.includes("domain:code"));
  t.true(
    update.calledOnceWith("session-1", "user-1", {
      activeScope: ["domain:code"],
    }),
  );
});

test("tryInterceptScopeCommand parses multiple space-separated scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code domain:writing",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["domain:code", "domain:writing"]);
  t.true(
    update.calledOnceWith("session-1", "user-1", {
      activeScope: ["domain:code", "domain:writing"],
    }),
  );
});

test("tryInterceptScopeCommand parses comma-separated scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code,domain:writing",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["domain:code", "domain:writing"]);
});

test("tryInterceptScopeCommand works with set scope prefix", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "set scope domain:writing",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.deepEqual(result!.newScope, ["domain:writing"]);
});

test("tryInterceptScopeCommand returns error message when session update fails", async (t) => {
  const update = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptScopeCommand(
    "!scope domain:code",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.includes("Failed to update scope"));
  t.deepEqual(result!.newScope, []);
});

test("tryInterceptScopeCommand does not call update for empty command", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  await tryInterceptScopeCommand(
    "!scope",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.false(update.called);
});

test("tryInterceptScopeCommand acknowledgment message lists all scopes", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code domain:writing",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.includes("domain:code"));
  t.true(result!.message.includes("domain:writing"));
});

function makeDb(distinctResult: string[]): Db {
  const col = {
    distinct: sinon.stub().resolves(distinctResult),
  } as unknown as Collection<unknown>;
  return {
    collection: sinon.stub().returns(col),
  } as unknown as Db;
}

test("fetchExistingUserScopes returns scopes from beliefs collection", async (t) => {
  const db = makeDb(["domain:code", "domain:writing"]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, ["domain:code", "domain:writing"]);
});

test("fetchExistingUserScopes filters out user:universal", async (t) => {
  const db = makeDb(["domain:code", "user:universal", "domain:writing"]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, ["domain:code", "domain:writing"]);
});

test("fetchExistingUserScopes filters out plain universal", async (t) => {
  const db = makeDb(["domain:code", "universal"]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, ["domain:code"]);
});

test("fetchExistingUserScopes returns empty array when user has no beliefs", async (t) => {
  const db = makeDb([]);
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, []);
});

test("fetchExistingUserScopes returns empty array when distinct throws", async (t) => {
  const col = {
    distinct: sinon.stub().rejects(new Error("mongo down")),
  } as unknown as Collection<unknown>;
  const db = {
    collection: sinon.stub().returns(col),
  } as unknown as Db;
  const result = await fetchExistingUserScopes("user-1", db);
  t.deepEqual(result, []);
});

test("fetchExistingUserScopes queries correct field and user_id", async (t) => {
  const distinct = sinon.stub().resolves(["domain:code"]);
  const col = { distinct } as unknown as Collection<unknown>;
  const db = {
    collection: sinon.stub().returns(col),
  } as unknown as Db;
  await fetchExistingUserScopes("user-42", db);
  t.true(distinct.calledOnceWith("scope", { user_id: "user-42" }));
});

function makeScopeDetectorDeps(
  responseContent: string,
  shouldThrow = false,
): ScopeDetectorDeps {
  const call = shouldThrow
    ? sinon.stub().rejects(new Error("provider down"))
    : sinon.stub().resolves({
        content: responseContent,
        model: "gpt-4o-mini",
        provider: "openai",
        finish_reason: "stop",
        usage: { input_tokens: 10, output_tokens: 5 },
      });

  return {
    db: makeDb([]),
    adapter: () => ({ id: "openai", call }),
    modelId: "gpt-4o-mini",
  };
}

test("detectScopeFromMessage returns parsed scope array", async (t) => {
  const deps = makeScopeDetectorDeps('["domain:code"]');
  const result = await detectScopeFromMessage(
    "how do I configure TypeScript strict mode?",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, ["domain:code"]);
});

test("detectScopeFromMessage returns multiple scopes", async (t) => {
  const deps = makeScopeDetectorDeps('["domain:code", "project:api-service"]');
  const result = await detectScopeFromMessage(
    "set up my new Node.js service",
    ["domain:code"],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, ["domain:code", "project:api-service"]);
});

test("detectScopeFromMessage returns empty array when model returns []", async (t) => {
  const deps = makeScopeDetectorDeps("[]");
  const result = await detectScopeFromMessage(
    "hello there",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, []);
});

test("detectScopeFromMessage extracts JSON array from prose response", async (t) => {
  const deps = makeScopeDetectorDeps(
    'Based on the message, I would say ["domain:writing"] is appropriate.',
  );
  const result = await detectScopeFromMessage(
    "help me with my novel",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, ["domain:writing"]);
});

test("detectScopeFromMessage returns empty array when provider throws", async (t) => {
  const deps = makeScopeDetectorDeps("", true);
  const result = await detectScopeFromMessage(
    "any message",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, []);
});

test("detectScopeFromMessage returns empty array when response is not parseable", async (t) => {
  const deps = makeScopeDetectorDeps("Sorry I cannot determine the scope.");
  const result = await detectScopeFromMessage(
    "any message",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, []);
});

test("detectScopeFromMessage returns empty array when parsed value is not an array", async (t) => {
  const deps = makeScopeDetectorDeps('{"scope": "domain:code"}');
  const result = await detectScopeFromMessage(
    "any message",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, []);
});

test("detectScopeFromMessage filters out non-string entries from parsed array", async (t) => {
  const deps = makeScopeDetectorDeps(
    '["domain:code", null, 42, "domain:writing"]',
  );
  const result = await detectScopeFromMessage(
    "any message",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.deepEqual(result, ["domain:code", "domain:writing"]);
});

test("detectScopeFromMessage truncates very long messages before sending", async (t) => {
  const call = sinon.stub().resolves({
    content: '["domain:code"]',
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const deps: ScopeDetectorDeps = {
    db: makeDb([]),
    adapter: () => ({ id: "openai", call }),
    modelId: "gpt-4o-mini",
  };
  const longMessage = "x".repeat(2000);
  await detectScopeFromMessage(longMessage, [], deps, NOOP_LOGGER);
  const sentContent = call.firstCall.args[0].messages[0].content as string;
  t.true(sentContent.length <= 600);
});

test("detectScopeFromMessage includes existing scopes in prompt when provided", async (t) => {
  const call = sinon.stub().resolves({
    content: '["domain:code"]',
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const deps: ScopeDetectorDeps = {
    db: makeDb([]),
    adapter: () => ({ id: "openai", call }),
    modelId: "gpt-4o-mini",
  };
  await detectScopeFromMessage(
    "help with my project",
    ["domain:code", "domain:writing"],
    deps,
    NOOP_LOGGER,
  );
  const sentContent = call.firstCall.args[0].messages[0].content as string;
  t.true(sentContent.includes("domain:code"));
  t.true(sentContent.includes("domain:writing"));
});

test("detectScopeFromMessage uses low temperature for determinism", async (t) => {
  const call = sinon.stub().resolves({
    content: '["domain:code"]',
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  const deps: ScopeDetectorDeps = {
    db: makeDb([]),
    adapter: () => ({ id: "openai", call }),
    modelId: "gpt-4o-mini",
  };
  await detectScopeFromMessage("any message", [], deps, NOOP_LOGGER);
  t.is(call.firstCall.args[0].temperature, 0);
});

test("detectScopeFromMessage uses configured modelId", async (t) => {
  const call = sinon.stub().resolves({
    content: "[]",
    model: "gpt-4o-mini",
    provider: "openai",
    finish_reason: "stop",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  const deps: ScopeDetectorDeps = {
    db: makeDb([]),
    adapter: () => ({ id: "openai", call }),
    modelId: "gpt-4o-mini",
  };
  await detectScopeFromMessage("any message", [], deps, NOOP_LOGGER);
  t.is(call.firstCall.args[0].model, "gpt-4o-mini");
});

test("tryInterceptScopeCommand expands sub-domain scope to include parent", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code/typescript",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.newScope.includes("domain:code/typescript"));
  t.true(result!.newScope.includes("domain:code"));
  t.true(
    update.calledOnceWith("session-1", "user-1", {
      activeScope: result!.newScope,
    }),
  );
});

test("tryInterceptScopeCommand expands deep sub-domain to all parent levels", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code/typescript/react",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.newScope.includes("domain:code/typescript/react"));
  t.true(result!.newScope.includes("domain:code/typescript"));
  t.true(result!.newScope.includes("domain:code"));
});

test("tryInterceptScopeCommand does not duplicate when multiple scopes share parent", async (t) => {
  const update = sinon.stub().resolves({ activeScope: [] });
  const result = await tryInterceptScopeCommand(
    "!scope domain:code/typescript domain:code/python",
    "session-1",
    "user-1",
    makeSessionsDep(update),
    NOOP_LOGGER,
  );
  t.truthy(result);
  const domainCodeCount = result!.newScope.filter(
    (s) => s === "domain:code",
  ).length;
  t.is(domainCodeCount, 1);
});

test("detectScopeFromMessage expands sub-domain in returned scopes", async (t) => {
  const deps = makeScopeDetectorDeps('["domain:code/typescript"]');
  const result = await detectScopeFromMessage(
    "how do I configure TypeScript strict mode?",
    [],
    deps,
    NOOP_LOGGER,
  );
  t.true(result.includes("domain:code/typescript"));
  t.true(result.includes("domain:code"));
});

test("detectScopeFromMessage does not duplicate parent when model returns both", async (t) => {
  const deps = makeScopeDetectorDeps(
    '["domain:code/typescript", "domain:code"]',
  );
  const result = await detectScopeFromMessage(
    "TypeScript question",
    [],
    deps,
    NOOP_LOGGER,
  );
  const count = result.filter((s) => s === "domain:code").length;
  t.is(count, 1);
});

test("expandScopeHierarchy returns flat scope unchanged", (t) => {
  t.deepEqual(expandScopeHierarchy(["domain:code"]), ["domain:code"]);
});

test("expandScopeHierarchy expands one level of sub-domain", (t) => {
  const result = expandScopeHierarchy(["domain:code/typescript"]);
  t.true(result.includes("domain:code/typescript"));
  t.true(result.includes("domain:code"));
  t.is(result.length, 2);
});

test("expandScopeHierarchy expands two levels of sub-domain", (t) => {
  const result = expandScopeHierarchy(["domain:code/typescript/react"]);
  t.true(result.includes("domain:code/typescript/react"));
  t.true(result.includes("domain:code/typescript"));
  t.true(result.includes("domain:code"));
  t.is(result.length, 3);
});

test("expandScopeHierarchy deduplicates shared parents", (t) => {
  const result = expandScopeHierarchy([
    "domain:code/typescript",
    "domain:code/python",
  ]);
  const domainCodeEntries = result.filter((s) => s === "domain:code");
  t.is(domainCodeEntries.length, 1);
});

test("expandScopeHierarchy handles mixed flat and hierarchical scopes", (t) => {
  const result = expandScopeHierarchy([
    "user:universal",
    "domain:code/typescript",
  ]);
  t.true(result.includes("user:universal"));
  t.true(result.includes("domain:code/typescript"));
  t.true(result.includes("domain:code"));
});

test("expandScopeHierarchy returns empty array for empty input", (t) => {
  t.deepEqual(expandScopeHierarchy([]), []);
});

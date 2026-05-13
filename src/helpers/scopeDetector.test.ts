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
  matchInjectCommand,
  tryInterceptInjectCommand,
  matchExtractCommand,
  tryInterceptExtractCommand,
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

test("matchExtractCommand returns null for a regular message", (t) => {
  t.is(matchExtractCommand("what is Redis?"), null);
});

test("matchExtractCommand returns null for empty string", (t) => {
  t.is(matchExtractCommand(""), null);
});

test("matchExtractCommand returns null for partial prefix", (t) => {
  t.is(matchExtractCommand("!extract"), null);
});

test("matchExtractCommand returns null when prefix appears mid-message", (t) => {
  t.is(matchExtractCommand("please !extract off for me"), null);
});

test("matchExtractCommand matches !extract off", (t) => {
  t.is(matchExtractCommand("!extract off"), "off");
});

test("matchExtractCommand matches !extract on", (t) => {
  t.is(matchExtractCommand("!extract on"), "on");
});

test("matchExtractCommand matches !extract global off", (t) => {
  t.is(matchExtractCommand("!extract global off"), "global-off");
});

test("matchExtractCommand matches !extract global on", (t) => {
  t.is(matchExtractCommand("!extract global on"), "global-on");
});

test("matchExtractCommand is case-insensitive", (t) => {
  t.is(matchExtractCommand("!EXTRACT OFF"), "off");
  t.is(matchExtractCommand("!Extract On"), "on");
  t.is(matchExtractCommand("!EXTRACT GLOBAL OFF"), "global-off");
});

test("matchExtractCommand ignores surrounding whitespace", (t) => {
  t.is(matchExtractCommand("  !extract off  "), "off");
  t.is(matchExtractCommand("  !extract global on  "), "global-on");
});

test("matchExtractCommand returns null for unknown subcommand", (t) => {
  t.is(matchExtractCommand("!extract pause"), null);
  t.is(matchExtractCommand("!extract disable"), null);
});

function makeExtractDeps(
  overrides: {
    sessionUpdate?: sinon.SinonStub;
    runtimeSet?: sinon.SinonStub;
  } = {},
) {
  return {
    sessions: {
      update: overrides.sessionUpdate ?? sinon.stub().resolves({}),
    },
    runtimeStore: {
      set: overrides.runtimeSet ?? sinon.stub().resolves(),
    },
  };
}

test("tryInterceptExtractCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptExtractCommand(
    "what is Redis?",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER,
  );
  t.is(result, null);
});

test("tryInterceptExtractCommand returns null for bare !extract", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER,
  );
  t.is(result, null);
});

test("tryInterceptExtractCommand off: updates session with extractionPaused true", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      extractionPaused: true,
    }),
  );
});

test("tryInterceptExtractCommand off: confirmation message mentions extract on", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.includes("!extract on"));
});

test("tryInterceptExtractCommand off: confirmation message mentions injection still active", async (t) => {
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps(),
    NOOP_LOGGER,
  );
  t.truthy(result);

  t.true(
    result!.message.toLowerCase().includes("inject") ||
      result!.message.toLowerCase().includes("existing beliefs"),
  );
});

test("tryInterceptExtractCommand off: does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.false(runtimeSet.called);
});

test("tryInterceptExtractCommand on: updates session with extractionPaused false", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptExtractCommand(
    "!extract on",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      extractionPaused: false,
    }),
  );
});

test("tryInterceptExtractCommand on: does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptExtractCommand(
    "!extract on",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.false(runtimeSet.called);
});

test("tryInterceptExtractCommand global-off: sets extraction_enabled false in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptExtractCommand(
    "!extract global off",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("extraction_enabled", false));
});

test("tryInterceptExtractCommand global-off: does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptExtractCommand(
    "!extract global off",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptExtractCommand global-on: sets extraction_enabled true in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptExtractCommand(
    "!extract global on",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("extraction_enabled", true));
});

test("tryInterceptExtractCommand global-on: does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptExtractCommand(
    "!extract global on",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptExtractCommand off: returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptExtractCommand(
    "!extract off",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptExtractCommand on: returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptExtractCommand(
    "!extract on",
    "session-1",
    "user-1",
    makeExtractDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptExtractCommand global-off: returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptExtractCommand(
    "!extract global off",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptExtractCommand global-on: returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptExtractCommand(
    "!extract global on",
    "session-1",
    "user-1",
    makeExtractDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("matchInjectCommand returns null for a regular message", (t) => {
  t.is(matchInjectCommand("what is Redis?"), null);
});

test("matchInjectCommand returns null for empty string", (t) => {
  t.is(matchInjectCommand(""), null);
});

test("matchInjectCommand returns null for bare !inject", (t) => {
  t.is(matchInjectCommand("!inject"), null);
});

test("matchInjectCommand returns null when prefix appears mid-message", (t) => {
  t.is(matchInjectCommand("please !inject off for me"), null);
});

test("matchInjectCommand matches !inject off", (t) => {
  t.is(matchInjectCommand("!inject off"), "off");
});

test("matchInjectCommand matches !inject on", (t) => {
  t.is(matchInjectCommand("!inject on"), "on");
});

test("matchInjectCommand matches !inject global off", (t) => {
  t.is(matchInjectCommand("!inject global off"), "global-off");
});

test("matchInjectCommand matches !inject global on", (t) => {
  t.is(matchInjectCommand("!inject global on"), "global-on");
});

test("matchInjectCommand is case-insensitive", (t) => {
  t.is(matchInjectCommand("!INJECT OFF"), "off");
  t.is(matchInjectCommand("!Inject On"), "on");
  t.is(matchInjectCommand("!INJECT GLOBAL OFF"), "global-off");
});

test("matchInjectCommand ignores surrounding whitespace", (t) => {
  t.is(matchInjectCommand("  !inject off  "), "off");
  t.is(matchInjectCommand("  !inject global on  "), "global-on");
});

test("matchInjectCommand returns null for unknown subcommand", (t) => {
  t.is(matchInjectCommand("!inject pause"), null);
  t.is(matchInjectCommand("!inject disable"), null);
});

function makeInjectDeps(
  overrides: {
    sessionUpdate?: sinon.SinonStub;
    runtimeSet?: sinon.SinonStub;
  } = {},
) {
  return {
    sessions: {
      update: overrides.sessionUpdate ?? sinon.stub().resolves({}),
    },
    runtimeStore: {
      set: overrides.runtimeSet ?? sinon.stub().resolves(),
    },
  };
}

test("tryInterceptInjectCommand returns null for non-command message", async (t) => {
  const result = await tryInterceptInjectCommand(
    "what is Redis?",
    "session-1",
    "user-1",
    makeInjectDeps(),
    NOOP_LOGGER,
  );
  t.is(result, null);
});

test("tryInterceptInjectCommand off: updates session with injectionPaused true", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      injectionPaused: true,
    }),
  );
});

test("tryInterceptInjectCommand off: confirmation message mentions extraction still running", async (t) => {
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps(),
    NOOP_LOGGER,
  );
  t.truthy(result);

  t.true(result!.message.toLowerCase().includes("extract"));
});

test("tryInterceptInjectCommand off: confirmation message mentions !inject on to resume", async (t) => {
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps(),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.includes("!inject on"));
});

test("tryInterceptInjectCommand off: does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.false(runtimeSet.called);
});

test("tryInterceptInjectCommand on: updates session with injectionPaused false", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  const result = await tryInterceptInjectCommand(
    "!inject on",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(
    sessionUpdate.calledOnceWith("session-1", "user-1", {
      injectionPaused: false,
    }),
  );
});

test("tryInterceptInjectCommand on: does not touch runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  await tryInterceptInjectCommand(
    "!inject on",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.false(runtimeSet.called);
});

test("tryInterceptInjectCommand global-off: sets injection_enabled false in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptInjectCommand(
    "!inject global off",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("injection_enabled", false));
});

test("tryInterceptInjectCommand global-off: does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptInjectCommand(
    "!inject global off",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptInjectCommand global-on: sets injection_enabled true in runtimeStore", async (t) => {
  const runtimeSet = sinon.stub().resolves();
  const result = await tryInterceptInjectCommand(
    "!inject global on",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(runtimeSet.calledOnceWith("injection_enabled", true));
});

test("tryInterceptInjectCommand global-on: does not touch session", async (t) => {
  const sessionUpdate = sinon.stub().resolves({});
  await tryInterceptInjectCommand(
    "!inject global on",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.false(sessionUpdate.called);
});

test("tryInterceptInjectCommand off: returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptInjectCommand(
    "!inject off",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptInjectCommand on: returns error message when session update fails", async (t) => {
  const sessionUpdate = sinon.stub().rejects(new Error("mongo down"));
  const result = await tryInterceptInjectCommand(
    "!inject on",
    "session-1",
    "user-1",
    makeInjectDeps({ sessionUpdate }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptInjectCommand global-off: returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptInjectCommand(
    "!inject global off",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("tryInterceptInjectCommand global-on: returns error message when runtimeStore set fails", async (t) => {
  const runtimeSet = sinon.stub().rejects(new Error("config db down"));
  const result = await tryInterceptInjectCommand(
    "!inject global on",
    "session-1",
    "user-1",
    makeInjectDeps({ runtimeSet }),
    NOOP_LOGGER,
  );
  t.truthy(result);
  t.true(result!.message.toLowerCase().includes("failed"));
});

test("!extract off does not match inject command parser", (t) => {
  t.is(matchInjectCommand("!extract off"), null);
});

test("!inject off does not match extract command parser", (t) => {
  t.is(matchExtractCommand("!inject off"), null);
});

test("!extract global off does not match inject command parser", (t) => {
  t.is(matchInjectCommand("!extract global off"), null);
});

test("!inject global off does not match extract command parser", (t) => {
  t.is(matchExtractCommand("!inject global off"), null);
});

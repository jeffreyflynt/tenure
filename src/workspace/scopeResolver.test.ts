import test from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { WorkspaceStateCache } from "./stateCache.js";
import { resolveIdeScope, type ResolvedScope } from "./scopeResolver.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("scope-resolver-test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

const USER_ID = "user-scope-test";

function makeHeaders(
  overrides: Record<string, string> = {},
): Record<string, string | undefined> {
  return { ...overrides };
}

function makeCache(): WorkspaceStateCache {
  return new WorkspaceStateCache(db);
}

test.serial(
  "priority 1: returns extension source when workspace state has project_name",
  async (t) => {
    const cache = makeCache();
    await cache.set(USER_ID, {
      workspace_root: "/home/dev/my-project",
      project_name: "My Project",
      active_package: null,
      git_remote: null,
      active_file: null,
      active_language: "typescript",
      updated_at: new Date(),
    });

    const result = resolveIdeScope(USER_ID, cache, makeHeaders());
    t.is(result.source, "extension");
    t.is(result.projectScope, "project:my-project");
    t.is(result.languageScope, "domain:code/typescript");
  },
);

test.serial(
  "priority 1: slugifies project_name correctly (special chars)",
  async (t) => {
    const cache = makeCache();
    await cache.set(USER_ID, {
      workspace_root: "/home/dev/app",
      project_name: "@scope/My--Cool App!!",
      active_package: null,
      git_remote: null,
      active_file: null,
      active_language: null,
      updated_at: new Date(),
    });

    const result = resolveIdeScope(USER_ID, cache, makeHeaders());
    t.is(result.source, "extension");
    t.is(result.projectScope, "project:scope-my-cool-app");
    t.is(result.languageScope, null);
  },
);

test.serial(
  "priority 1: returns null languageScope when active_language is not set",
  async (t) => {
    const cache = makeCache();
    await cache.set(USER_ID, {
      workspace_root: "/home/dev/app",
      project_name: "app",
      active_package: null,
      git_remote: null,
      active_file: null,
      active_language: null,
      updated_at: new Date(),
    });

    const result = resolveIdeScope(USER_ID, cache, makeHeaders());
    t.is(result.languageScope, null);
  },
);

test.serial("priority 1: maps known languages correctly", async (t) => {
  const cache = makeCache();

  const cases: Array<[string, string]> = [
    ["typescript", "domain:code/typescript"],
    ["typescriptreact", "domain:code/typescript"],
    ["javascript", "domain:code/javascript"],
    ["python", "domain:code/python"],
    ["rust", "domain:code/rust"],
    ["go", "domain:code/go"],
    ["java", "domain:code/java"],
    ["ruby", "domain:code/ruby"],
    ["swift", "domain:code/swift"],
    ["kotlin", "domain:code/kotlin"],
    ["cpp", "domain:code/cpp"],
    ["c", "domain:code/c"],
    ["csharp", "domain:code/csharp"],
    ["php", "domain:code/php"],
    ["shellscript", "domain:code/shell"],
  ];

  for (const [lang, expected] of cases) {
    await cache.set(USER_ID, {
      workspace_root: "/dev",
      project_name: "test",
      active_package: null,
      git_remote: null,
      active_file: null,
      active_language: lang,
      updated_at: new Date(),
    });

    const result = resolveIdeScope(USER_ID, cache, makeHeaders());
    t.is(
      result.languageScope,
      expected,
      `language "${lang}" should map to "${expected}"`,
    );
  }
});

test.serial(
  "priority 1: unknown language falls back to domain:code",
  async (t) => {
    const cache = makeCache();
    await cache.set(USER_ID, {
      workspace_root: "/dev",
      project_name: "test",
      active_package: null,
      git_remote: null,
      active_file: null,
      active_language: "haskell",
      updated_at: new Date(),
    });

    const result = resolveIdeScope(USER_ID, cache, makeHeaders());
    t.is(result.languageScope, "domain:code");
  },
);

test.serial(
  "priority 2: returns header source when x-tenure-project is set and no extension state",
  async (t) => {
    const cache = makeCache();

    const result = resolveIdeScope(
      "user-no-state",
      cache,
      makeHeaders({ "x-tenure-project": "MyApp" }),
    );

    t.is(result.source, "header");
    t.is(result.projectScope, "project:myapp");
    t.is(result.languageScope, null);
  },
);

test.serial(
  "priority 2: includes domain from x-tenure-domain header",
  async (t) => {
    const cache = makeCache();
    const result = resolveIdeScope(
      "user-no-state",
      cache,
      makeHeaders({
        "x-tenure-project": "Backend",
        "x-tenure-domain": "typescript",
      }),
    );

    t.is(result.source, "header");
    t.is(result.projectScope, "project:backend");
    t.is(result.languageScope, "domain:typescript");
  },
);

test.serial(
  "priority 2: extension state takes precedence over headers",
  async (t) => {
    const cache = makeCache();
    await cache.set("user-both", {
      workspace_root: "/dev",
      project_name: "from-extension",
      active_package: null,
      git_remote: null,
      active_file: null,
      active_language: null,
      updated_at: new Date(),
    });

    const result = resolveIdeScope(
      "user-both",
      cache,
      makeHeaders({ "x-tenure-project": "from-header" }),
    );

    t.is(result.source, "extension");
    t.is(result.projectScope, "project:from-extension");
  },
);

test.serial(
  "priority 3: extracts project from system prompt when no extension state or headers",
  async (t) => {
    const cache = makeCache();
    const systemPrompt = "project: my-cool-project";

    const result = resolveIdeScope(
      "user-no-state-2",
      cache,
      makeHeaders(),
      systemPrompt,
    );

    t.is(result.source, "payload");
    t.is(result.projectScope, "project:my-cool-project");
  },
);

test.serial(
  "priority 3: extracts language from active file extension in system prompt",
  async (t) => {
    const cache = makeCache();
    const systemPrompt = "project: api-server\nActive file: src/index.ts";

    const result = resolveIdeScope(
      "user-no-state-3",
      cache,
      makeHeaders(),
      systemPrompt,
    );

    t.is(result.source, "payload");
    t.is(result.projectScope, "project:api-server");
    t.is(result.languageScope, "domain:code/typescript");
  },
);

test.serial("priority 3: maps various file extensions correctly", async (t) => {
  const cache = makeCache();

  const cases: Array<[string, string]> = [
    ["main.py", "domain:code/python"],
    ["lib.rs", "domain:code/rust"],
    ["app.go", "domain:code/go"],
    ["Main.java", "domain:code/java"],
    ["script.rb", "domain:code/ruby"],
    ["app.swift", "domain:code/swift"],
    ["Main.kt", "domain:code/kotlin"],
    ["algo.cpp", "domain:code/cpp"],
    ["driver.c", "domain:code/c"],
    ["Program.cs", "domain:code/csharp"],
    ["index.php", "domain:code/php"],
    ["deploy.sh", "domain:code/shell"],
    ["component.tsx", "domain:code/typescript"],
    ["component.jsx", "domain:code/javascript"],
  ];

  for (const [file, expected] of cases) {
    const systemPrompt = `Current file: ${file}`;
    const result = resolveIdeScope(
      "user-ext-map",
      cache,
      makeHeaders(),
      systemPrompt,
    );

    t.is(
      result.languageScope,
      expected,
      `file "${file}" should yield "${expected}"`,
    );
  }
});

test.serial(
  "priority 3: unknown file extension falls back to domain:code",
  async (t) => {
    const cache = makeCache();
    const systemPrompt = "Working in project: test\nActive file: data.xyz";

    const result = resolveIdeScope(
      "user-unknown-ext",
      cache,
      makeHeaders(),
      systemPrompt,
    );

    t.is(result.languageScope, "domain:code");
  },
);

test.serial(
  "priority 3: headers take precedence over system prompt",
  async (t) => {
    const cache = makeCache();
    const systemPrompt = "Working in project: from-prompt";

    const result = resolveIdeScope(
      "user-header-vs-prompt",
      cache,
      makeHeaders({ "x-tenure-project": "from-header" }),
      systemPrompt,
    );

    t.is(result.source, "header");
    t.is(result.projectScope, "project:from-header");
  },
);

test.serial("priority 4: returns fallback when nothing matches", async (t) => {
  const cache = makeCache();
  const result = resolveIdeScope("user-empty", cache, makeHeaders(), undefined);

  t.is(result.source, "fallback");
  t.is(result.projectScope, null);
  t.is(result.languageScope, null);
});

test.serial(
  "priority 4: returns fallback when system prompt has no recognizable patterns",
  async (t) => {
    const cache = makeCache();
    const result = resolveIdeScope(
      "user-empty-2",
      cache,
      makeHeaders(),
      "You are a helpful assistant. Be concise.",
    );

    t.is(result.source, "fallback");
    t.is(result.projectScope, null);
    t.is(result.languageScope, null);
  },
);

import test from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { WorkspaceStateCache, type WorkspaceState } from "./stateCache.js";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("state-cache-test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await db.collection("workspace_state").deleteMany({});
});

const USER_ID = "user-cache-test";

function makeState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    workspace_root: "/home/dev/project",
    project_name: "my-project",
    git_remote: "git@github.com:user/my-project.git",
    active_file: "/home/dev/project/src/index.ts",
    active_language: "typescript",
    updated_at: new Date(),
    ...overrides,
  };
}

test.serial("set stores state in memory and get retrieves it", async (t) => {
  const cache = new WorkspaceStateCache(db);
  const state = makeState();
  await cache.set(USER_ID, state);

  const retrieved = cache.get(USER_ID);
  t.truthy(retrieved);
  t.is(retrieved!.workspace_root, "/home/dev/project");
  t.is(retrieved!.project_name, "my-project");
  t.is(retrieved!.active_language, "typescript");
});

test.serial("get returns null for unknown user", (t) => {
  const cache = new WorkspaceStateCache(db);
  t.is(cache.get("nonexistent-user"), null);
});

test.serial("set persists state to MongoDB", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState());

  const doc = await db.collection("workspace_state").findOne({ _id: USER_ID });
  t.truthy(doc);
  t.is(doc!.project_name, "my-project");
  t.is(doc!.user_id, USER_ID);
});

test.serial("set upserts on repeated calls for the same user", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ project_name: "first" }));
  await cache.set(USER_ID, makeState({ project_name: "second" }));

  const count = await db
    .collection("workspace_state")
    .countDocuments({ _id: USER_ID });
  t.is(count, 1);

  const doc = await db.collection("workspace_state").findOne({ _id: USER_ID });
  t.is(doc!.project_name, "second");
});

test.serial(
  "load retrieves state from MongoDB when not in memory",
  async (t) => {
    const cache1 = new WorkspaceStateCache(db);
    await cache1.set(USER_ID, makeState({ project_name: "persisted" }));

    const cache2 = new WorkspaceStateCache(db);
    t.is(cache2.get(USER_ID), null);

    const loaded = await cache2.load(USER_ID);
    t.truthy(loaded);
    t.is(loaded!.project_name, "persisted");
    t.is(loaded!.active_language, "typescript");
  },
);

test.serial(
  "load returns cached in-memory value without hitting DB",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ project_name: "in-memory" }));

    await db
      .collection("workspace_state")
      .updateOne({ _id: USER_ID }, { $set: { project_name: "from-db" } });

    const loaded = await cache.load(USER_ID);
    t.is(loaded!.project_name, "in-memory");
  },
);

test.serial(
  "load returns null when user has no state in DB or memory",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    const loaded = await cache.load("ghost-user");
    t.is(loaded, null);
  },
);

test.serial("load populates in-memory cache after DB read", async (t) => {
  const cache1 = new WorkspaceStateCache(db);
  await cache1.set(USER_ID, makeState({ project_name: "test" }));

  const cache2 = new WorkspaceStateCache(db);
  await cache2.load(USER_ID);

  const fromMemory = cache2.get(USER_ID);
  t.truthy(fromMemory);
  t.is(fromMemory!.project_name, "test");
});

test.serial("resolveProjectScope returns null when user has no state", (t) => {
  const cache = new WorkspaceStateCache(db);
  t.is(cache.resolveProjectScope("no-state-user"), null);
});

test.serial(
  "resolveProjectScope returns null when project_name is empty",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ project_name: "" }));
    t.is(cache.resolveProjectScope(USER_ID), null);
  },
);

test.serial("resolveProjectScope returns project: prefixed slug", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ project_name: "My Cool App" }));
  t.is(cache.resolveProjectScope(USER_ID), "project:my-cool-app");
});

test.serial(
  "resolveProjectScope strips leading/trailing hyphens",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ project_name: "---test---" }));
    t.is(cache.resolveProjectScope(USER_ID), "project:test");
  },
);

test.serial("resolveProjectScope collapses consecutive hyphens", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ project_name: "hello   world" }));
  t.is(cache.resolveProjectScope(USER_ID), "project:hello-world");
});

test.serial(
  "resolveProjectScope removes non-alphanumeric characters",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ project_name: "@scope/my_app!" }));
    t.is(cache.resolveProjectScope(USER_ID), "project:scope-my-app");
  },
);

test.serial("resolveLanguageScope returns null when user has no state", (t) => {
  const cache = new WorkspaceStateCache(db);
  t.is(cache.resolveLanguageScope("no-state-user"), null);
});

test.serial(
  "resolveLanguageScope returns null when active_language is null",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ active_language: null }));
    t.is(cache.resolveLanguageScope(USER_ID), null);
  },
);

test.serial("resolveLanguageScope maps typescript correctly", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ active_language: "typescript" }));
  t.is(cache.resolveLanguageScope(USER_ID), "domain:code/typescript");
});

test.serial(
  "resolveLanguageScope maps typescriptreact to typescript domain",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ active_language: "typescriptreact" }));
    t.is(cache.resolveLanguageScope(USER_ID), "domain:code/typescript");
  },
);

test.serial("resolveLanguageScope maps python correctly", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ active_language: "python" }));
  t.is(cache.resolveLanguageScope(USER_ID), "domain:code/python");
});

test.serial("resolveLanguageScope maps rust correctly", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ active_language: "rust" }));
  t.is(cache.resolveLanguageScope(USER_ID), "domain:code/rust");
});

test.serial("resolveLanguageScope maps shellscript to shell", async (t) => {
  const cache = new WorkspaceStateCache(db);
  await cache.set(USER_ID, makeState({ active_language: "shellscript" }));
  t.is(cache.resolveLanguageScope(USER_ID), "domain:code/shell");
});

test.serial(
  "resolveLanguageScope returns domain:code for unknown language",
  async (t) => {
    const cache = new WorkspaceStateCache(db);
    await cache.set(USER_ID, makeState({ active_language: "brainfuck" }));
    t.is(cache.resolveLanguageScope(USER_ID), "domain:code");
  },
);

test.serial("resolveLanguageScope maps all supported languages", async (t) => {
  const cache = new WorkspaceStateCache(db);

  const expected: Array<[string, string]> = [
    ["typescript", "domain:code/typescript"],
    ["typescriptreact", "domain:code/typescript"],
    ["javascript", "domain:code/javascript"],
    ["javascriptreact", "domain:code/javascript"],
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
    ["shell", "domain:code/shell"],
    ["shellscript", "domain:code/shell"],
  ];

  for (const [lang, scope] of expected) {
    await cache.set(USER_ID, makeState({ active_language: lang }));
    t.is(
      cache.resolveLanguageScope(USER_ID),
      scope,
      `language "${lang}" should resolve to "${scope}"`,
    );
  }
});

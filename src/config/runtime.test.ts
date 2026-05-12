import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db, type Collection } from "mongodb";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeConfigStore } from "./runtime.js";
import { CredentialVault } from "./encryption.js";
import type { Collections, ConfigDoc } from "../db/collections.js";

const test = anyTest.serial as TestFn;

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let configCol: Collection<ConfigDoc>;
let vault: CredentialVault;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
  configCol = db.collection<ConfigDoc>("config");

  const dir = mkdtempSync(join(tmpdir(), "runtime-test-"));
  vault = new CredentialVault(join(dir, "master.key"));
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.beforeEach(async () => {
  await configCol.deleteMany({});
});

function makeCollections(overrides: Partial<Collections> = {}): Collections {
  return {
    config: configCol,
    beliefs: null as any,
    turns: null as any,
    sessions: null as any,
    jobs: null as any,
    errors: null as any,
    topic_index: null as any,
    persona_cache: null as any,
    compaction_log: null as any,
    ...overrides,
  };
}
test("load returns defaults when collection is empty", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);
  const cfg = await store.load();

  t.is(cfg.default_provider, "openai");
  t.is(cfg.openai_api_key, null);
  t.is(cfg.anthropic_api_key, null);
  t.is(cfg.always_on_token_target, 400);
  t.is(cfg.managed_history_token_cap, 120000);
  t.true(cfg.buffered_mode);
  t.is(cfg.error_retention_days, 30);
  t.is(cfg.openai_base_url, null);
});

test("set persists a plain string value and load retrieves it", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("default_provider", "anthropic");
  const cfg = await store.load();

  t.is(cfg.default_provider, "anthropic");
});

test("set persists a numeric value and load retrieves it", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("always_on_token_target", 800);
  const cfg = await store.load();

  t.is(cfg.always_on_token_target, 800);
});

test("set upserts — second call overwrites first", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("error_retention_days", 7);
  await store.set("error_retention_days", 90);
  const cfg = await store.load();

  t.is(cfg.error_retention_days, 90);
  const count = await configCol.countDocuments({ key: "error_retention_days" });
  t.is(count, 1);
});

test("set encrypts openai_api_key before storing", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("openai_api_key", "sk-real-key");
  const doc = await configCol.findOne({ key: "openai_api_key" });

  t.true(doc!.encrypted);
  t.not(doc!.value, "sk-real-key");
  t.is(typeof doc!.value, "string");
});

test("load decrypts openai_api_key transparently", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("openai_api_key", "sk-real-key");
  const cfg = await store.load();

  t.is(cfg.openai_api_key, "sk-real-key");
});

test("set encrypts anthropic_api_key before storing", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("anthropic_api_key", "sk-ant-secret");
  const doc = await configCol.findOne({ key: "anthropic_api_key" });

  t.true(doc!.encrypted);
  t.not(doc!.value, "sk-ant-secret");
});

test("load decrypts anthropic_api_key transparently", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("anthropic_api_key", "sk-ant-secret");
  const cfg = await store.load();

  t.is(cfg.anthropic_api_key, "sk-ant-secret");
});

test("non-sensitive keys are stored as plaintext (encrypted=false)", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("default_provider", "ollama");
  const doc = await configCol.findOne({ key: "default_provider" });

  t.false(doc!.encrypted);
  t.is(doc!.value, "ollama");
});

test("set stores updatedAt as a Date", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);
  const before = new Date();

  await store.set("error_retention_days", 14);

  const doc = await configCol.findOne({ key: "error_retention_days" });
  t.true(doc!.updatedAt >= before);
  t.true(doc!.updatedAt <= new Date());
});

test("load ignores keys not present in defaults", async (t) => {
  await configCol.insertOne({
    _id: "unknown-key" as any,
    key: "totally_unknown",
    value: "whatever",
    encrypted: false,
    updatedAt: new Date(),
  });

  const store = new RuntimeConfigStore(makeCollections(), vault);
  const cfg = await store.load();

  t.false("totally_unknown" in cfg);
  t.is(cfg.default_provider, "openai");
});

test("load merges multiple stored keys with defaults", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);

  await store.set("default_provider", "bedrock");
  await store.set("always_on_token_target", 200);
  await store.set("openai_api_key", "sk-key");

  const cfg = await store.load();

  t.is(cfg.default_provider, "bedrock");
  t.is(cfg.always_on_token_target, 200);
  t.is(cfg.openai_api_key, "sk-key");
  t.is(cfg.managed_history_token_cap, 120000);
  t.is(cfg.anthropic_api_key, null);
});

test("load returns extraction_enabled true by default", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);
  const cfg = await store.load();
  t.true(cfg.extraction_enabled);
});

test("set persists extraction_enabled false and load retrieves it", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);
  await store.set("extraction_enabled", false);
  const cfg = await store.load();
  t.false(cfg.extraction_enabled);
});

test("load returns strict_model_tiers true by default", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);
  const cfg = await store.load();
  t.true(cfg.strict_model_tiers);
});

test("set persists strict_model_tiers false and load retrieves it", async (t) => {
  const store = new RuntimeConfigStore(makeCollections(), vault);
  await store.set("strict_model_tiers", false);
  const cfg = await store.load();
  t.false(cfg.strict_model_tiers);
});

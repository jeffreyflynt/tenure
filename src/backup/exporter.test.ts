import anyTest, { type TestFn } from "ava";
import sinon from "sinon";
import { BackupExporter, type ExporterDeps } from "./exporter.js";
import { decryptArchive } from "./crypto.js";
import type { TenureExport } from "./types.js";

interface Context {
  deps: ExporterDeps;
  exporter: BackupExporter;
}

const test = anyTest as TestFn<Context>;

const USER_ID = "user-backup-test";

function makeBelief(overrides: Record<string, unknown> = {}) {
  return {
    _id: `belief-${Math.random().toString(36).slice(2)}`,
    user_id: USER_ID,
    type: "preference",
    subtype: null,
    canonical_name: "test_belief",
    aliases: ["alias1"],
    content: "Test content",
    why_it_matters: "Test importance",
    scope: ["user:universal"],
    provenance: {
      session_id: "session-1",
      turn_id: "turn-1",
      extracted_at: new Date("2025-01-01"),
      source_model: "anthropic:claude-haiku-4-5-20251001",
    },
    epistemic_status: "active",
    confidence: 0.9,
    reinforcement_count: 1,
    last_reinforced_at: new Date("2025-01-02"),
    pinned: false,
    user_edited: false,
    superseded_by: null,
    resolved_at: null,
    change_log: [
      {
        changed_at: new Date("2025-01-01"),
        trigger: "extraction",
        changed_by_session: "session-1",
        changed_by_turn: "turn-1",
      },
    ],
    created_at: new Date("2025-01-01"),
    updated_at: new Date("2025-01-02"),
    ...overrides,
  };
}

function makePersonaDoc() {
  return {
    _id: USER_ID,
    universal: "A developer who prefers concise responses",
    per_scope: { "project:my-app": "Working on a React dashboard" },
    contributing_belief_ids: ["b1", "b2"],
    beliefs_hash: "abc123",
    generated_at: new Date("2025-01-03"),
    model: "claude-haiku-4-5-20251001",
  };
}

function makeCompactionEntry() {
  return {
    _id: "comp-1",
    user_id: USER_ID,
    scope: "user:universal",
    belief_type: "preference",
    ran_at: new Date("2025-01-04"),
    merged_count: 3,
  };
}

function makeSession() {
  return {
    _id: "session-1",
    userId: USER_ID,
    providerId: "anthropic",
    model: "claude-haiku-4-5-20251001",
    activeScope: ["user:universal"],
    createdAt: new Date("2025-01-01"),
    lastUsedAt: new Date("2025-01-05"),
  };
}

function makeRuntimeConfig() {
  return {
    default_provider: "anthropic",
    default_model: "claude-haiku-4-5-20251001",
    openai_api_key: "sk-openai-test",
    anthropic_api_key: "sk-ant-test",
    openai_base_url: null,
    anthropic_base_url: null,
    openai_endpoint_flavor: "generic",
    always_on_token_target: 400,
    managed_history_token_cap: 120000,
    error_retention_days: 30,
    strict_model_tiers: true,
    extraction_enabled: true,
  };
}

function makeDeps(
  options: {
    beliefs?: unknown[];
    persona?: unknown | null;
    compactionLog?: unknown[];
    sessions?: unknown[];
    runtimeConfig?: Record<string, unknown>;
  } = {},
): ExporterDeps {
  const beliefs = options.beliefs ?? [makeBelief()];
  const persona =
    options.persona !== undefined ? options.persona : makePersonaDoc();
  const compactionLog = options.compactionLog ?? [makeCompactionEntry()];
  const sessions = options.sessions ?? [makeSession()];

  const toArrayStub = (data: unknown[]) => ({
    toArray: sinon.stub().resolves(data),
  });

  const db = {
    collection: sinon.stub().callsFake((name: string) => {
      if (name === "beliefs") {
        return { find: sinon.stub().returns(toArrayStub(beliefs)) };
      }
      if (name === "persona_cache") {
        return { findOne: sinon.stub().resolves(persona) };
      }
      if (name === "compaction_log") {
        return { find: sinon.stub().returns(toArrayStub(compactionLog)) };
      }
      if (name === "sessions") {
        return { find: sinon.stub().returns(toArrayStub(sessions)) };
      }
      return { find: sinon.stub().returns(toArrayStub([])) };
    }),
  } as unknown as ExporterDeps["db"];

  const runtimeStore = {
    load: sinon.stub().resolves(options.runtimeConfig ?? makeRuntimeConfig()),
    set: sinon.stub().resolves(),
  } as unknown as ExporterDeps["runtimeStore"];

  return { db, runtimeStore, userId: USER_ID };
}

test.beforeEach((t) => {
  const deps = makeDeps();
  t.context = { deps, exporter: new BackupExporter(deps) };
});

test("exportUnencrypted returns version 1 payload", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.version, 1);
});

test("exportUnencrypted includes exported_at timestamp", async (t) => {
  const before = new Date().toISOString();
  const payload = await t.context.exporter.exportUnencrypted();
  const after = new Date().toISOString();

  t.true(payload.exported_at >= before);
  t.true(payload.exported_at <= after);
});

test("exportUnencrypted includes user_id", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.user_id, USER_ID);
});

test("exportUnencrypted serializes beliefs with ISO date strings", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.beliefs.length, 1);
  t.is(typeof payload.beliefs[0].created_at, "string");
  t.is(typeof payload.beliefs[0].updated_at, "string");
  t.is(typeof payload.beliefs[0].provenance.extracted_at, "string");
  t.is(typeof payload.beliefs[0].last_reinforced_at, "string");
  t.is(typeof payload.beliefs[0].change_log[0].changed_at, "string");
});

test("exportUnencrypted preserves belief fields", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  const b = payload.beliefs[0];
  t.is(b.type, "preference");
  t.is(b.canonical_name, "test_belief");
  t.deepEqual(b.aliases, ["alias1"]);
  t.is(b.content, "Test content");
  t.is(b.why_it_matters, "Test importance");
  t.deepEqual(b.scope, ["user:universal"]);
  t.is(b.confidence, 0.9);
  t.is(b.epistemic_status, "active");
});

test("exportUnencrypted includes runtime config", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.runtime_config.default_provider, "anthropic");
  t.is(payload.runtime_config.default_model, "claude-haiku-4-5-20251001");
  t.is(payload.runtime_config.openai_api_key, "sk-openai-test");
  t.is(payload.runtime_config.anthropic_api_key, "sk-ant-test");
  t.is(payload.runtime_config.extraction_enabled, true);
});

test("exportUnencrypted includes persona cache", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.truthy(payload.persona_cache);
  t.is(
    payload.persona_cache!.universal,
    "A developer who prefers concise responses",
  );
  t.is(typeof payload.persona_cache!.generated_at, "string");
});

test("exportUnencrypted returns null persona when none exists", async (t) => {
  const deps = makeDeps({ persona: null });
  const exporter = new BackupExporter(deps);
  const payload = await exporter.exportUnencrypted();
  t.is(payload.persona_cache, null);
});

test("exportUnencrypted includes compaction log", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.compaction_log.length, 1);
  t.is(payload.compaction_log[0].scope, "user:universal");
  t.is(payload.compaction_log[0].merged_count, 3);
  t.is(typeof payload.compaction_log[0].ran_at, "string");
});

test("exportUnencrypted includes sessions", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.sessions.length, 1);
  t.is(payload.sessions[0]._id, "session-1");
  t.is(payload.sessions[0].providerId, "anthropic");
  t.is(typeof payload.sessions[0].createdAt, "string");
});

test("exportUnencrypted handles empty collections", async (t) => {
  const deps = makeDeps({
    beliefs: [],
    persona: null,
    compactionLog: [],
    sessions: [],
  });
  const exporter = new BackupExporter(deps);
  const payload = await exporter.exportUnencrypted();

  t.is(payload.beliefs.length, 0);
  t.is(payload.persona_cache, null);
  t.is(payload.compaction_log.length, 0);
  t.is(payload.sessions.length, 0);
});

test("exportUnencrypted handles multiple beliefs", async (t) => {
  const beliefs = [
    makeBelief({ _id: "b1", canonical_name: "first" }),
    makeBelief({ _id: "b2", canonical_name: "second" }),
    makeBelief({ _id: "b3", canonical_name: "third" }),
  ];
  const deps = makeDeps({ beliefs });
  const exporter = new BackupExporter(deps);
  const payload = await exporter.exportUnencrypted();

  t.is(payload.beliefs.length, 3);
  t.is(payload.beliefs[0].canonical_name, "first");
  t.is(payload.beliefs[2].canonical_name, "third");
});

test("exportUnencrypted serializes resolved_at as ISO string when present", async (t) => {
  const beliefs = [makeBelief({ resolved_at: new Date("2025-02-01") })];
  const deps = makeDeps({ beliefs });
  const exporter = new BackupExporter(deps);
  const payload = await exporter.exportUnencrypted();

  t.is(payload.beliefs[0].resolved_at, "2025-02-01T00:00:00.000Z");
});

test("exportUnencrypted serializes resolved_at as null when absent", async (t) => {
  const payload = await t.context.exporter.exportUnencrypted();
  t.is(payload.beliefs[0].resolved_at, null);
});

test("export produces encrypted buffer that can be decrypted", async (t) => {
  const passphrase = "test-export-passphrase";
  const encrypted = await t.context.exporter.export(passphrase);

  t.true(Buffer.isBuffer(encrypted));
  t.true(encrypted.length > 0);

  const decrypted = decryptArchive(encrypted, passphrase);
  const payload = JSON.parse(decrypted.toString("utf-8")) as TenureExport;
  t.is(payload.version, 1);
  t.is(payload.user_id, USER_ID);
  t.is(payload.beliefs.length, 1);
});

test("export with wrong passphrase fails to decrypt", async (t) => {
  const encrypted = await t.context.exporter.export("correct-pass");

  t.throws(() => decryptArchive(encrypted, "wrong-pass"), {
    message: /Decryption failed|Wrong passphrase/,
  });
});

test("exportUnencrypted includes expertise fields when present", async (t) => {
  const beliefs = [
    makeBelief({
      expertise_domain: "typescript",
      expertise_depth: "advanced",
      expertise_evidence_count: 5,
    }),
  ];
  const deps = makeDeps({ beliefs });
  const exporter = new BackupExporter(deps);
  const payload = await exporter.exportUnencrypted();

  t.is(payload.beliefs[0].expertise_domain, "typescript");
  t.is(payload.beliefs[0].expertise_depth, "advanced");
  t.is(payload.beliefs[0].expertise_evidence_count, 5);
});

test("exportUnencrypted includes compaction_note when present", async (t) => {
  const beliefs = [makeBelief({ compaction_note: "Merged from 3 beliefs" })];
  const deps = makeDeps({ beliefs });
  const exporter = new BackupExporter(deps);
  const payload = await exporter.exportUnencrypted();

  t.is(payload.beliefs[0].compaction_note, "Merged from 3 beliefs");
});

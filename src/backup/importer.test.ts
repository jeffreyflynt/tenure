import anyTest, { type TestFn } from "ava";
import sinon from "sinon";
import {
  BackupImporter,
  type ImporterDeps,
  type ImportOptions,
} from "./importer.js";
import { encryptArchive } from "./crypto.js";
import type { TenureExport } from "./types.js";

interface Context {
  deps: ImporterDeps;
  importer: BackupImporter;
  beliefsCol: {
    findOne: sinon.SinonStub;
    insertMany: sinon.SinonStub;
  };
  personaCol: {
    replaceOne: sinon.SinonStub;
  };
  compactionCol: {
    insertMany: sinon.SinonStub;
  };
  sessionsCol: {
    replaceOne: sinon.SinonStub;
  };
  runtimeStore: {
    load: sinon.SinonStub;
    set: sinon.SinonStub;
  };
}

const test = anyTest as TestFn<Context>;

const USER_ID = "user-import-test";

function makeExportPayload(
  overrides: Partial<TenureExport> = {},
): TenureExport {
  return {
    version: 1,
    exported_at: "2025-01-15T10:00:00.000Z",
    user_id: "original-user",
    beliefs: [
      {
        _id: "belief-1",
        type: "preference",
        subtype: null,
        canonical_name: "prefers_concise",
        aliases: ["likes_short"],
        content: "Prefers concise responses",
        why_it_matters: "Controls verbosity",
        scope: ["user:universal"],
        provenance: {
          session_id: "session-orig",
          turn_id: "turn-orig",
          extracted_at: "2025-01-01T00:00:00.000Z",
          source_model: "anthropic:claude-haiku-4-5-20251001",
        },
        epistemic_status: "active",
        confidence: 0.9,
        reinforcement_count: 2,
        last_reinforced_at: "2025-01-10T00:00:00.000Z",
        pinned: true,
        user_edited: false,
        superseded_by: null,
        resolved_at: null,
        change_log: [
          {
            changed_at: "2025-01-01T00:00:00.000Z",
            trigger: "extraction",
            changed_by_session: "session-orig",
            changed_by_turn: "turn-orig",
          },
        ],
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-10T00:00:00.000Z",
      },
    ],
    runtime_config: {
      default_provider: "anthropic",
      default_model: "claude-haiku-4-5-20251001",
      openai_api_key: "sk-openai-imported",
      anthropic_api_key: "sk-ant-imported",
      openai_base_url: null,
      anthropic_base_url: null,
      openai_endpoint_flavor: "generic",
      always_on_token_target: 500,
      managed_history_token_cap: 100000,
      error_retention_days: 14,
      strict_model_tiers: true,
      extraction_enabled: true,
    },
    persona_cache: {
      universal: "A concise developer",
      per_scope: { "project:app": "React developer" },
      contributing_belief_ids: ["belief-1"],
      beliefs_hash: "hash123",
      generated_at: "2025-01-12T00:00:00.000Z",
      model: "claude-haiku-4-5-20251001",
    },
    compaction_log: [
      {
        _id: "comp-1",
        user_id: "original-user",
        scope: "user:universal",
        belief_type: "preference",
        ran_at: "2025-01-14T00:00:00.000Z",
        merged_count: 2,
      },
    ],
    sessions: [
      {
        _id: "session-orig",
        userId: "original-user",
        providerId: "anthropic",
        model: "claude-haiku-4-5-20251001",
        activeScope: ["user:universal"],
        createdAt: "2025-01-01T00:00:00.000Z",
        lastUsedAt: "2025-01-15T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function makeDeps(): Context {
  const beliefsCol = {
    findOne: sinon.stub().resolves(null),
    insertMany: sinon.stub().resolves({ insertedCount: 1 }),
  };
  const personaCol = {
    replaceOne: sinon.stub().resolves(),
  };
  const compactionCol = {
    insertMany: sinon.stub().resolves(),
  };
  const sessionsCol = {
    replaceOne: sinon.stub().resolves(),
  };

  const db = {
    collection: sinon.stub().callsFake((name: string) => {
      if (name === "beliefs") return beliefsCol;
      if (name === "persona_cache") return personaCol;
      if (name === "compaction_log") return compactionCol;
      if (name === "sessions") return sessionsCol;
      return {};
    }),
  } as unknown as ImporterDeps["db"];

  const runtimeStore = {
    load: sinon.stub().resolves({}),
    set: sinon.stub().resolves(),
  };

  const deps: ImporterDeps = {
    db,
    runtimeStore: runtimeStore as unknown as ImporterDeps["runtimeStore"],
    userId: USER_ID,
  };

  const importer = new BackupImporter(deps);

  return {
    deps,
    importer,
    beliefsCol,
    personaCol,
    compactionCol,
    sessionsCol,
    runtimeStore,
  };
}

test.beforeEach((t) => {
  t.context = makeDeps();
});

test("importPayload imports beliefs", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload);

  t.is(result.beliefs_imported, 1);
  t.is(result.beliefs_skipped, 0);
  t.true(t.context.beliefsCol.insertMany.calledOnce);
});

test("importPayload remaps user_id by default", async (t) => {
  const payload = makeExportPayload();
  await t.context.importer.importPayload(payload);

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  t.is(inserted[0].user_id, USER_ID);
});

test("importPayload preserves original user_id when remapUserId is false", async (t) => {
  const payload = makeExportPayload();
  await t.context.importer.importPayload(payload, { remapUserId: false });

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  t.is(inserted[0].user_id, "original-user");
});

test("importPayload skips existing beliefs when skipExisting is true", async (t) => {
  t.context.beliefsCol.findOne.resolves({ _id: "belief-1" });

  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload, {
    skipExisting: true,
  });

  t.is(result.beliefs_imported, 0);
  t.is(result.beliefs_skipped, 1);
  t.false(t.context.beliefsCol.insertMany.called);
});

test("importPayload converts ISO date strings back to Date objects", async (t) => {
  const payload = makeExportPayload();
  await t.context.importer.importPayload(payload);

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  const belief = inserted[0];
  t.true(belief.created_at instanceof Date);
  t.true(belief.updated_at instanceof Date);
  t.true(belief.last_reinforced_at instanceof Date);
  t.true(belief.provenance.extracted_at instanceof Date);
  t.true(belief.change_log[0].changed_at instanceof Date);
});

test("importPayload restores runtime config", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload, {
    importConfig: true,
  });

  t.true(result.config_restored);
  t.true(t.context.runtimeStore.set.called);

  const setCalls = t.context.runtimeStore.set.args.map(
    (call) => [call[0], call[1]] as [string, unknown],
  );
  t.true(
    setCalls.some(
      ([k, v]) => k === "default_model" && v === "claude-haiku-4-5-20251001",
    ),
  );
  t.true(
    setCalls.some(
      ([k, v]) => k === "anthropic_api_key" && v === "sk-ant-imported",
    ),
  );
  t.true(
    setCalls.some(([k, v]) => k === "always_on_token_target" && v === 500),
  );
});

test("importPayload skips runtime config when importConfig is false", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload, {
    importConfig: false,
  });

  t.false(result.config_restored);
  t.false(t.context.runtimeStore.set.called);
});

test("importPayload restores persona cache", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload);

  t.true(result.persona_restored);
  t.true(t.context.personaCol.replaceOne.calledOnce);

  const [filter, doc, opts] = t.context.personaCol.replaceOne.firstCall.args;
  t.deepEqual(filter, { _id: USER_ID });
  t.is(doc.universal, "A concise developer");
  t.true(doc.generated_at instanceof Date);
  t.deepEqual(opts, { upsert: true });
});

test("importPayload handles null persona cache", async (t) => {
  const payload = makeExportPayload({ persona_cache: null });
  const result = await t.context.importer.importPayload(payload);

  t.false(result.persona_restored);
  t.false(t.context.personaCol.replaceOne.called);
});

test("importPayload imports compaction log", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload);

  t.is(result.compaction_entries_imported, 1);
  t.true(t.context.compactionCol.insertMany.calledOnce);

  const inserted = t.context.compactionCol.insertMany.firstCall.args[0];
  t.is(inserted[0].user_id, USER_ID);
  t.true(inserted[0].ran_at instanceof Date);
});

test("importPayload does not import sessions by default", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload);

  t.is(result.sessions_imported, 0);
  t.false(t.context.sessionsCol.replaceOne.called);
});

test("importPayload imports sessions when importSessions is true", async (t) => {
  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload, {
    importSessions: true,
  });

  t.is(result.sessions_imported, 1);
  t.true(t.context.sessionsCol.replaceOne.calledOnce);

  const [filter, doc] = t.context.sessionsCol.replaceOne.firstCall.args;
  t.deepEqual(filter, { _id: "session-orig" });
  t.is(doc.userId, USER_ID);
  t.true(doc.createdAt instanceof Date);
  t.true(doc.lastUsedAt instanceof Date);
});

test("importPayload rejects unsupported version", async (t) => {
  const payload = makeExportPayload({ version: 99 as any });

  const err = await t.throwsAsync(() =>
    t.context.importer.importPayload(payload),
  );
  t.regex(err!.message, /Unsupported export version/);
});

test("importPayload handles empty beliefs array", async (t) => {
  const payload = makeExportPayload({ beliefs: [] });
  const result = await t.context.importer.importPayload(payload);

  t.is(result.beliefs_imported, 0);
  t.is(result.beliefs_skipped, 0);
  t.false(t.context.beliefsCol.insertMany.called);
});

test("importPayload handles empty compaction_log", async (t) => {
  const payload = makeExportPayload({ compaction_log: [] });
  const result = await t.context.importer.importPayload(payload);

  t.is(result.compaction_entries_imported, 0);
  t.false(t.context.compactionCol.insertMany.called);
});

test("importPayload handles duplicate key errors gracefully", async (t) => {
  const dupError = new Error("duplicate key") as Error & { code: number };
  dupError.code = 11000;
  t.context.beliefsCol.insertMany.rejects(dupError);

  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload, {
    skipExisting: false,
  });

  t.is(result.beliefs_skipped, 1);
});

test("importPayload re-throws non-duplicate errors", async (t) => {
  const otherError = new Error("connection failed") as Error & { code: number };
  otherError.code = 12345;
  t.context.beliefsCol.insertMany.rejects(otherError);

  const payload = makeExportPayload();
  await t.throwsAsync(
    () => t.context.importer.importPayload(payload, { skipExisting: false }),
    {
      message: /connection failed/,
    },
  );
});

test("importPayload handles compaction log duplicate key errors gracefully", async (t) => {
  const dupError = new Error("duplicate key") as Error & { code: number };
  dupError.code = 11000;
  t.context.compactionCol.insertMany.rejects(dupError);

  const payload = makeExportPayload();
  const result = await t.context.importer.importPayload(payload);

  t.is(result.compaction_entries_imported, 1);
});

test("importPayload converts resolved_at back to Date when present", async (t) => {
  const payload = makeExportPayload();
  payload.beliefs[0].resolved_at = "2025-02-01T00:00:00.000Z";
  await t.context.importer.importPayload(payload);

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  t.true(inserted[0].resolved_at instanceof Date);
});

test("importPayload handles null resolved_at", async (t) => {
  const payload = makeExportPayload();
  payload.beliefs[0].resolved_at = null;
  await t.context.importer.importPayload(payload);

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  t.is(inserted[0].resolved_at, null);
});

test("importEncrypted decrypts and imports", async (t) => {
  const payload = makeExportPayload();
  const passphrase = "import-test-pass";
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    passphrase,
  );

  const result = await t.context.importer.importEncrypted(
    encrypted,
    passphrase,
  );

  t.is(result.beliefs_imported, 1);
  t.true(result.config_restored);
});

test("importEncrypted throws on wrong passphrase", async (t) => {
  const payload = makeExportPayload();
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    "correct-pass",
  );

  const err = await t.throwsAsync(() =>
    t.context.importer.importEncrypted(encrypted, "wrong-pass"),
  );
  t.regex(err!.message, /Decryption failed|Wrong passphrase/);
});

test("importPayload preserves expertise fields", async (t) => {
  const payload = makeExportPayload();
  payload.beliefs[0].expertise_domain = "typescript";
  payload.beliefs[0].expertise_depth = "advanced";
  payload.beliefs[0].expertise_evidence_count = 5;

  await t.context.importer.importPayload(payload);

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  t.is(inserted[0].expertise_domain, "typescript");
  t.is(inserted[0].expertise_depth, "advanced");
  t.is(inserted[0].expertise_evidence_count, 5);
});

test("importPayload preserves compaction_note", async (t) => {
  const payload = makeExportPayload();
  payload.beliefs[0].compaction_note = "Merged from 3 beliefs";

  await t.context.importer.importPayload(payload);

  const inserted = t.context.beliefsCol.insertMany.firstCall.args[0];
  t.is(inserted[0].compaction_note, "Merged from 3 beliefs");
});

test("importPayload batches large belief inserts", async (t) => {
  const beliefs = Array.from({ length: 1200 }, (_, i) => ({
    ...makeExportPayload().beliefs[0],
    _id: `belief-${i}`,
    canonical_name: `belief_${i}`,
  }));
  const payload = makeExportPayload({ beliefs });

  await t.context.importer.importPayload(payload, { skipExisting: false });

  t.is(t.context.beliefsCol.insertMany.callCount, 3);
  t.is(t.context.beliefsCol.insertMany.firstCall.args[0].length, 500);
  t.is(t.context.beliefsCol.insertMany.secondCall.args[0].length, 500);
  t.is(t.context.beliefsCol.insertMany.thirdCall.args[0].length, 200);
});

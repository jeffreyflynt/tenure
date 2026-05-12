import anyTest, { type TestFn } from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import sinon from "sinon";
import { registerBackupRoutes, type BackupDeps } from "./backup.js";
import { encryptArchive } from "../backup/crypto.js";
import type { TenureExport } from "../backup/types.js";

interface Context {
  app: FastifyInstance;
  deps: BackupDeps;
}

const test = anyTest as TestFn<Context>;

const USER_ID = "user-backup-route-test";

function makeRuntimeConfig() {
  return {
    default_provider: "anthropic",
    default_model: "claude-haiku-4-5-20251001",
    openai_api_key: null,
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

function makeBelief() {
  return {
    _id: "belief-route-1",
    user_id: USER_ID,
    type: "preference",
    subtype: null,
    canonical_name: "test_belief",
    aliases: [],
    content: "Test content",
    why_it_matters: "Test importance",
    scope: ["user:universal"],
    provenance: {
      session_id: "s1",
      turn_id: "t1",
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
    change_log: [],
    created_at: new Date("2025-01-01"),
    updated_at: new Date("2025-01-02"),
  };
}

function toArrayStub(data: unknown[]) {
  return { toArray: sinon.stub().resolves(data) };
}

function makeDeps(): BackupDeps {
  const db = {
    collection: sinon.stub().callsFake((name: string) => {
      if (name === "beliefs") {
        return {
          find: sinon.stub().returns(toArrayStub([makeBelief()])),
          findOne: sinon.stub().resolves(null),
          insertMany: sinon.stub().resolves({ insertedCount: 1 }),
        };
      }
      if (name === "persona_cache") {
        return {
          findOne: sinon.stub().resolves(null),
          replaceOne: sinon.stub().resolves(),
        };
      }
      if (name === "compaction_log") {
        return {
          find: sinon.stub().returns(toArrayStub([])),
          insertMany: sinon.stub().resolves(),
        };
      }
      if (name === "sessions") {
        return {
          find: sinon.stub().returns(toArrayStub([])),
          replaceOne: sinon.stub().resolves(),
        };
      }
      return {
        find: sinon.stub().returns(toArrayStub([])),
        findOne: sinon.stub().resolves(null),
      };
    }),
  } as unknown as BackupDeps["db"];

  const runtimeStore = {
    load: sinon.stub().resolves(makeRuntimeConfig()),
    set: sinon.stub().resolves(),
  } as unknown as BackupDeps["runtimeStore"];

  return { db, runtimeStore, userId: USER_ID };
}

test.beforeEach((t) => {
  const deps = makeDeps();
  const app = Fastify();
  registerBackupRoutes(app, deps);
  t.context = { app, deps };
});

test("POST /v1/backup/export returns 400 when passphrase is missing", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/export",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /Passphrase/i);
});

test("POST /v1/backup/export returns 400 when passphrase is too short", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/export",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "short" }),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /at least 8/);
});

test("POST /v1/backup/export returns encrypted binary archive", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/export",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "valid-passphrase-here" }),
  });

  t.is(res.statusCode, 200);
  t.is(res.headers["content-type"], "application/octet-stream");
  t.regex(
    res.headers["content-disposition"] as string,
    /attachment.*tenure-backup.*\.enc/,
  );
  t.truthy(res.headers["x-tenure-export-version"]);
  t.true(res.rawPayload.length > 0);
});

test("POST /v1/backup/export produces archive that can be decrypted", async (t) => {
  const passphrase = "my-export-passphrase";
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/export",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });

  t.is(res.statusCode, 200);

  const { decryptArchive } = await import("../backup/crypto.js");
  const decrypted = decryptArchive(res.rawPayload, passphrase);
  const payload = JSON.parse(decrypted.toString("utf-8")) as TenureExport;

  t.is(payload.version, 1);
  t.is(payload.user_id, USER_ID);
  t.is(payload.beliefs.length, 1);
  t.is(payload.beliefs[0].canonical_name, "test_belief");
});

test("GET /v1/backup/preview returns export summary", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: "/v1/backup/preview",
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.version, 1);
  t.is(body.user_id, USER_ID);
  t.truthy(body.exported_at);
  t.truthy(body.counts);
  t.is(typeof body.counts.beliefs, "number");
  t.is(typeof body.counts.beliefs_active, "number");
  t.is(typeof body.counts.sessions, "number");
  t.is(typeof body.counts.compaction_entries, "number");
  t.is(typeof body.counts.has_persona, "boolean");
  t.is(typeof body.counts.has_config, "boolean");
});

test("GET /v1/backup/preview does not include actual belief content", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: "/v1/backup/preview",
  });

  const body = JSON.parse(res.body);
  t.falsy(body.beliefs);
  t.falsy(body.runtime_config);
});

test("POST /v1/backup/import returns 400 when passphrase is missing", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archive: "abc" }),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /[Pp]assphrase/);
});

test("POST /v1/backup/import returns 400 when archive is missing", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "valid-pass" }),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /archive/);
});

test("POST /v1/backup/import returns 401 on wrong passphrase", async (t) => {
  const payload = makeExportPayload();
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    "correct-pass",
  );
  const base64 = encrypted.toString("base64");

  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase: "wrong-pass", archive: base64 }),
  });

  t.is(res.statusCode, 401);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /[Ww]rong passphrase|corrupted/);
});

test("POST /v1/backup/import returns 422 on unsupported version", async (t) => {
  const payload = { ...makeExportPayload(), version: 99 };
  const passphrase = "test-passphrase";
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    passphrase,
  );
  const base64 = encrypted.toString("base64");

  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase, archive: base64 }),
  });

  t.is(res.statusCode, 422);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /[Uu]nsupported export version/);
});

test("POST /v1/backup/import succeeds with valid archive", async (t) => {
  const payload = makeExportPayload();
  const passphrase = "import-test-pass";
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    passphrase,
  );
  const base64 = encrypted.toString("base64");

  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ passphrase, archive: base64 }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.ok);
  t.truthy(body.result);
  t.is(typeof body.result.beliefs_imported, "number");
  t.is(typeof body.result.beliefs_skipped, "number");
  t.is(typeof body.result.config_restored, "boolean");
  t.is(typeof body.result.persona_restored, "boolean");
});

test("POST /v1/backup/import respects skip_existing option", async (t) => {
  const payload = makeExportPayload();
  const passphrase = "import-pass";
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    passphrase,
  );
  const base64 = encrypted.toString("base64");

  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      passphrase,
      archive: base64,
      skip_existing: true,
    }),
  });

  t.is(res.statusCode, 200);
});

test("POST /v1/backup/import respects import_config option", async (t) => {
  const payload = makeExportPayload();
  const passphrase = "import-pass";
  const encrypted = encryptArchive(
    Buffer.from(JSON.stringify(payload), "utf-8"),
    passphrase,
  );
  const base64 = encrypted.toString("base64");

  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/backup/import",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      passphrase,
      archive: base64,
      import_config: false,
    }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.false(body.result.config_restored);
});

function makeExportPayload(): TenureExport {
  return {
    version: 1,
    exported_at: "2025-01-15T10:00:00.000Z",
    user_id: "original-user",
    beliefs: [
      {
        _id: "belief-import-1",
        type: "preference",
        subtype: null,
        canonical_name: "imported_belief",
        aliases: [],
        content: "Imported content",
        why_it_matters: "Imported importance",
        scope: ["user:universal"],
        provenance: {
          session_id: "s1",
          turn_id: "t1",
          extracted_at: "2025-01-01T00:00:00.000Z",
          source_model: "anthropic:claude-haiku-4-5-20251001",
        },
        epistemic_status: "active",
        confidence: 0.85,
        reinforcement_count: 1,
        last_reinforced_at: "2025-01-05T00:00:00.000Z",
        pinned: false,
        user_edited: false,
        superseded_by: null,
        resolved_at: null,
        change_log: [],
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-05T00:00:00.000Z",
      },
    ],
    runtime_config: {
      default_provider: "anthropic",
      default_model: "claude-haiku-4-5-20251001",
      openai_api_key: null,
      anthropic_api_key: "sk-ant-imported",
      openai_base_url: null,
      anthropic_base_url: null,
      openai_endpoint_flavor: "generic",
      always_on_token_target: 400,
      managed_history_token_cap: 120000,
      error_retention_days: 30,
      strict_model_tiers: true,
      extraction_enabled: true,
    },
    persona_cache: null,
    compaction_log: [],
    sessions: [],
  };
}

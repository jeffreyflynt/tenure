import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import sinon from "sinon";

import { buildServer, type ServerDeps } from "./server.js";
import { getCollections } from "./db/collections.js";
import { SessionManager } from "./session/manager.js";
import { HistoryManager } from "./history/manager.js";
import { ContextBuilder } from "./context/contextBuilder.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ExtractionJobQueue } from "./jobs/queue.js";
import { ErrorLogger } from "./errors/logger.js";
import type { BeliefCompactionRunner } from "./jobs/compactionRunner.js";
import type { PersonaCache } from "./context/personaCache.js";
import type { FastifyInstance } from "fastify";
import type { ExtractionWorker } from "./extraction/worker.js";

const test = anyTest.serial as TestFn;

const API_TOKEN = "test-secret-token";
const USER_ID = "test-user";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.afterEach(() => {
  sinon.restore();
});

function makeDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  const cols = getCollections(db);
  return {
    db,
    cols,
    sessions: new SessionManager(db),
    history: new HistoryManager(db),
    context: new ContextBuilder(
      {
        listByScope: sinon.stub().resolves([]),
        listPinnedFacts: sinon.stub().resolves([]),
        listPinnedOpenQuestions: sinon.stub().resolves([]),
        searchText: sinon.stub().resolves([]),
      } as any,
      { get: sinon.stub().resolves(null) } as unknown as PersonaCache,
    ),
    providers: new ProviderRegistry(),
    jobs: new ExtractionJobQueue(db),
    runtimeStore: {
      load: sinon.stub().resolves({}),
      set: sinon.stub().resolves(),
    } as any,
    errorLogger: new ErrorLogger(cols),
    persona: { get: sinon.stub().resolves(null) } as unknown as PersonaCache,
    compactionRunner: {
      run: sinon.stub().resolves(),
    } as unknown as BeliefCompactionRunner,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    } as unknown as ExtractionWorker,
    apiToken: API_TOKEN,
    userId: USER_ID,
    personaSummary: {
      ensureFresh: sinon.stub().resolves("regenerated"),
    } as any,
    ...overrides,
  };
}

let servers: FastifyInstance[] = [];

async function createServer(overrides: Partial<ServerDeps> = {}) {
  const server = await buildServer(makeDeps(overrides));
  servers.push(server);
  return server;
}

test.afterEach.always(async () => {
  sinon.restore();
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

function auth() {
  return { authorization: `Bearer ${API_TOKEN}` };
}

test("GET /healthz returns 200 without auth header", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/healthz" });
  t.is(res.statusCode, 200);
});

test("GET /v1/models returns 401 without auth header", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/v1/models" });
  t.is(res.statusCode, 401);
});

test("GET /v1/models returns 401 with wrong bearer token", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: "Bearer wrong-token" },
  });
  t.is(res.statusCode, 401);
});

test("GET /v1/models returns 401 with malformed auth header", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: { authorization: API_TOKEN },
  });
  t.is(res.statusCode, 401);
});

test("POST /v1/chat/completions returns 401 without auth", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "POST",
    url: "/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "x",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  t.is(res.statusCode, 401);
});

test("401 body contains { error: { message: 'unauthorized' } }", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/v1/models" });
  const body = JSON.parse(res.body);
  t.deepEqual(body, { error: { message: "unauthorized" } });
});

test("GET /v1/models returns 200 with valid bearer token", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });
  t.is(res.statusCode, 200);
});

test("GET /healthz returns { ok: true } when db is reachable", async (t) => {
  const server = await createServer();
  const res = await server.inject({ method: "GET", url: "/healthz" });
  t.is(res.statusCode, 200);
  t.deepEqual(JSON.parse(res.body), { ok: true });
});

test("GET /healthz returns 503 when db is unreachable", async (t) => {
  sinon.stub(db, "command").rejects(new Error("connection refused"));
  const server = await createServer();

  const res = await server.inject({ method: "GET", url: "/healthz" });

  t.is(res.statusCode, 503);
  const body = JSON.parse(res.body);
  t.is(body.ok, false);
  t.is(body.error, "database unreachable");
});

test("GET /v1/models returns { object: 'list', data } envelope", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });
  const body = JSON.parse(res.body);
  t.is(body.object, "list");
  t.true(Array.isArray(body.data));
});

test("GET /v1/models returns empty data when no providers registered", async (t) => {
  const server = await createServer();
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });
  t.deepEqual(JSON.parse(res.body).data, []);
});

test("GET /v1/models returns models from registered providers", async (t) => {
  const providers = new ProviderRegistry();
  providers.register({
    id: "stub",
    call: sinon.stub(),
    listModels: sinon.stub().resolves([
      { id: "model-a", object: "model", created: 0, owned_by: "stub" },
      { id: "model-b", object: "model", created: 0, owned_by: "stub" },
    ]),
  } as any);

  const server = await createServer(makeDeps({ providers }));
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });
  const body = JSON.parse(res.body);
  t.is(body.data.length, 2);
  t.is(body.data[0].id, "model-a");
  t.is(body.data[1].id, "model-b");
});

test("unhandled error returns 500 with type 'internal_error'", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("kaboom"));

  const server = await createServer(makeDeps({ providers }));
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  t.is(res.statusCode, 500);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "internal_error");
  t.is(body.error.message, "internal server error");
});

test("unhandled error does not leak original message or stack trace", async (t) => {
  const providers = new ProviderRegistry();
  sinon
    .stub(providers, "listModels")
    .rejects(new Error("secret db credentials in error"));

  const server = await createServer(makeDeps({ providers }));
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  t.false(res.body.includes("secret db credentials"));
  t.false(res.body.includes("at Object"));
});

test("error with statusCode < 500 returns original status and message", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").callsFake(async () => {
    const err = new Error("invalid scope parameter") as Error & {
      statusCode: number;
    };
    err.statusCode = 422;
    throw err;
  });

  const server = await createServer(makeDeps({ providers }));
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  t.is(res.statusCode, 422);
  const body = JSON.parse(res.body);
  t.is(body.error.type, "client_error");
  t.is(body.error.message, "invalid scope parameter");
});

test("error handler logs to ErrorLogger on 5xx", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("should be logged"));

  const errorLogger = {
    log: sinon.stub().resolves(),
  } as unknown as ErrorLogger;

  const server = await createServer(makeDeps({ providers, errorLogger }));
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  t.true((errorLogger.log as sinon.SinonStub).calledOnce);
  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.message, "should be logged");
  t.is(input.user_id, USER_ID);
});

test("error handler sets severity 'error' for 5xx errors", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("boom"));

  const errorLogger = {
    log: sinon.stub().resolves(),
  } as unknown as ErrorLogger;

  const server = await createServer(makeDeps({ providers, errorLogger }));
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.severity, "error");
});

test("error handler sets severity 'warning' for 4xx errors", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").callsFake(async () => {
    const err = new Error("bad input") as Error & { statusCode: number };
    err.statusCode = 400;
    throw err;
  });

  const errorLogger = {
    log: sinon.stub().resolves(),
  } as unknown as ErrorLogger;

  const server = await createServer(makeDeps({ providers, errorLogger }));
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.severity, "warning");
});

test("error handler passes the Error object for stack extraction", async (t) => {
  const providers = new ProviderRegistry();
  const original = new TypeError("type mismatch");
  sinon.stub(providers, "listModels").rejects(original);

  const errorLogger = {
    log: sinon.stub().resolves(),
  } as unknown as ErrorLogger;

  const server = await createServer(makeDeps({ providers, errorLogger }));
  await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  const input = (errorLogger.log as sinon.SinonStub).firstCall.args[0];
  t.is(input.error, original);
});

test("error handler does not throw when ErrorLogger rejects", async (t) => {
  const providers = new ProviderRegistry();
  sinon.stub(providers, "listModels").rejects(new Error("trigger"));

  const errorLogger = {
    log: sinon.stub().rejects(new Error("logger broken")),
  } as unknown as ErrorLogger;

  const server = await createServer(makeDeps({ providers, errorLogger }));
  const res = await server.inject({
    method: "GET",
    url: "/v1/models",
    headers: auth(),
  });

  t.is(res.statusCode, 500);
});

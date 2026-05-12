import anyTest, { type TestFn } from "ava";
import Fastify, { type FastifyInstance } from "fastify";
import sinon from "sinon";
import {
  registerOnboardingRoutes,
  type OnboardingDeps,
  ONBOARDING_QUESTIONS,
} from "./onboarding.js";
import type {
  ProviderAdapter,
  NormalizedResponse,
} from "../providers/types.js";
import { ProviderRegistry } from "../providers/registry.js";

interface Context {
  app: FastifyInstance;
  deps: OnboardingDeps;
  adapter: ProviderAdapter;
}

const test = anyTest as TestFn<Context>;

const USER_ID = "user-onboarding-test";
const MODEL = "claude-haiku-4-5-20251001";
const PROVIDER_ID = "anthropic";

function makeAdapter(
  response: Partial<NormalizedResponse> = {},
): ProviderAdapter {
  return {
    id: PROVIDER_ID,
    call: sinon.stub().resolves({
      content:
        '{"turn_signal":"substantive","new_beliefs":[],"belief_updates":[]}',
      model: MODEL,
      provider: PROVIDER_ID,
      finish_reason: "stop",
      usage: { input_tokens: 100, output_tokens: 200 },
      ...response,
    }),
    listModels: sinon.stub().resolves([
      { id: "claude-haiku-4-5-20251001", owned_by: "anthropic" },
      { id: "claude-sonnet-4-20250514", owned_by: "anthropic" },
    ]),
  };
}

function makeRuntimeStore(overrides: Record<string, unknown> = {}) {
  const config = {
    default_provider: PROVIDER_ID,
    default_model: MODEL,
    openai_api_key: null,
    openai_base_url: null,
    openai_endpoint_flavor: "generic" as const,
    anthropic_api_key: "sk-ant-test",
    anthropic_base_url: null,
    always_on_token_target: 400,
    managed_history_token_cap: 120000,
    error_retention_days: 7,
    ...overrides,
  };
  return {
    load: sinon.stub().resolves(config),
    set: sinon.stub().resolves(),
  };
}

function makeDeps(
  adapterOverride?: ProviderAdapter,
  storeOverrides?: Record<string, unknown>,
): { deps: OnboardingDeps; adapter: ProviderAdapter } {
  const adapter = adapterOverride ?? makeAdapter();
  const registry = new ProviderRegistry();
  registry.register(adapter);

  const deps: OnboardingDeps = {
    providers: registry,
    jobs: { enqueueOnboarding: sinon.stub().resolves("job-123") } as any,
    runtimeStore: makeRuntimeStore(storeOverrides) as any,
    extractionWorker: {
      processById: sinon.stub().resolves(),
      sweep: sinon.stub().resolves(0),
    },
    personaSummary: { ensureFresh: sinon.stub().resolves("regenerated") },
    userId: USER_ID,
  };

  return { deps, adapter };
}

function buildApp(deps: OnboardingDeps): FastifyInstance {
  const app = Fastify();
  registerOnboardingRoutes(app, deps);
  return app;
}

test.beforeEach((t) => {
  const { deps, adapter } = makeDeps();
  const app = buildApp(deps);
  t.context = { app, deps, adapter };
});

test("GET /onboarding returns 200 with text/html", async (t) => {
  const res = await t.context.app.inject({ method: "GET", url: "/onboarding" });

  t.is(res.statusCode, 200);
  t.regex(res.headers["content-type"] as string, /text\/html/);
});

test("GET /onboarding includes HTML document structure", async (t) => {
  const res = await t.context.app.inject({ method: "GET", url: "/onboarding" });

  t.true(res.body.includes("<!DOCTYPE html>"));
  t.true(res.body.includes('<div class="card" id="app">'));
});

test("GET /onboarding embeds token from query param", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: "/onboarding?token=onboard-token",
  });

  t.true(res.body.includes('"onboard-token"'));
});

test("GET /onboarding includes question and commit URLs", async (t) => {
  const res = await t.context.app.inject({ method: "GET", url: "/onboarding" });

  t.true(res.body.includes("/v1/onboarding/questions"));
  t.true(res.body.includes("/v1/onboarding/complete"));
  t.true(res.body.includes("/v1/onboarding/commit"));
});

test("GET /v1/onboarding/questions returns all questions", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: "/v1/onboarding/questions",
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.is(body.questions.length, ONBOARDING_QUESTIONS.length);
  t.is(body.total, ONBOARDING_QUESTIONS.length);
});

test("GET /v1/onboarding/questions returns questions with id, category, text", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: "/v1/onboarding/questions",
  });

  const body = JSON.parse(res.body);
  const first = body.questions[0];
  t.truthy(first.id);
  t.truthy(first.category);
  t.truthy(first.text);
});

test("POST /v1/onboarding/skip returns ok", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/skip",
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.ok);
  t.true(body.skipped);
});

test("POST /v1/onboarding/complete rejects missing answers", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /answers required/);
});

test("POST /v1/onboarding/complete rejects empty answers array", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: [] }),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /answers required/);
});

test("POST /v1/onboarding/complete returns 0 beliefs when all answers are blank", async (t) => {
  const answers = [
    { question_id: "response_length", question: "Q1", answer: "" },
    { question_id: "ai_corrections", question: "Q2", answer: "   " },
  ];

  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.ok);
  t.is(body.belief_count, 0);
  t.is(body.draft_id, null);
});

test("POST /v1/onboarding/complete calls LLM and returns extracted beliefs", async (t) => {
  const extractionResponse = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "preference",
        canonical_name: "prefers_concise",
        content: "wants short responses",
        why_it_matters: "shapes response length",
        scope: ["user:universal"],
        confidence: 0.9,
        epistemic_status: "active",
        aliases: [],
      },
    ],
    belief_updates: [],
  });

  const adapter = makeAdapter({ content: extractionResponse });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    {
      question_id: "response_length",
      question: "When you get a long response, do you read or skim?",
      answer: "I skim — keep it short please",
    },
  ];

  const res = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.ok);
  t.is(body.belief_count, 1);
  t.is(body.beliefs[0].canonical_name, "prefers_concise");
  t.truthy(body.draft_id);
});

test("POST /v1/onboarding/complete returns parse_failed when LLM returns garbage", async (t) => {
  const adapter = makeAdapter({ content: "This is not JSON at all!!!" });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "I skim" },
  ];

  const res = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.ok);
  t.is(body.belief_count, 0);
  t.true(body.parse_failed);
});

test("POST /v1/onboarding/complete returns 502 when LLM call throws", async (t) => {
  const adapter: ProviderAdapter = {
    id: PROVIDER_ID,
    call: sinon.stub().rejects(new Error("rate limited")),
  };
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "Keep it short" },
  ];

  const res = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });

  t.is(res.statusCode, 502);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /LLM call failed/);
});

test("POST /v1/onboarding/complete returns 400 when no default model configured", async (t) => {
  const { deps } = makeDeps(undefined, { default_model: null });
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "I skim" },
  ];

  const res = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /No default model/);
});

test("POST /v1/onboarding/complete detects project scope from current_project answer", async (t) => {
  const extractionResponse = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "entity",
        canonical_name: "react_dashboard",
        content: "building a React analytics dashboard",
        why_it_matters: "shapes technical suggestions",
        scope: ["user:universal", "project:react-analytics-dashboard"],
        confidence: 0.85,
        epistemic_status: "active",
        aliases: [],
      },
    ],
    belief_updates: [],
  });

  const adapter = makeAdapter({ content: extractionResponse });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    {
      question_id: "current_project",
      question: "What are you working on?",
      answer: "A React analytics dashboard for internal metrics",
    },
  ];

  const res = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.truthy(body.project_scope);
  t.regex(body.project_scope, /^project:/);
});

test("POST /v1/onboarding/commit rejects missing draft_id", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  t.is(res.statusCode, 400);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /draft_id required/);
});

test("POST /v1/onboarding/commit returns 404 for unknown draft_id", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft_id: "nonexistent-id" }),
  });

  t.is(res.statusCode, 404);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /draft not found/);
});

test("POST /v1/onboarding/commit enqueues job for valid draft", async (t) => {
  const extractionResponse = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "preference",
        canonical_name: "likes_terse",
        content: "prefers short answers",
        why_it_matters: "controls verbosity",
        scope: ["user:universal"],
        confidence: 0.9,
        epistemic_status: "active",
        aliases: [],
      },
    ],
    belief_updates: [],
  });

  const adapter = makeAdapter({ content: extractionResponse });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "Keep it terse" },
  ];

  const completeRes = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  const { draft_id } = JSON.parse(completeRes.body);

  const commitRes = await app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft_id }),
  });

  t.is(commitRes.statusCode, 200);
  const body = JSON.parse(commitRes.body);
  t.true(body.ok);
  t.is(body.job_id, "job-123");
  t.true((deps.jobs.enqueueOnboarding as sinon.SinonStub).calledOnce);
});

test("POST /v1/onboarding/commit accepts edited_beliefs to override draft", async (t) => {
  const extractionResponse = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "preference",
        canonical_name: "original",
        content: "original content",
        why_it_matters: "matters",
        scope: ["user:universal"],
        confidence: 0.9,
        epistemic_status: "active",
        aliases: [],
      },
      {
        type: "preference",
        canonical_name: "to_remove",
        content: "this one gets removed",
        why_it_matters: "user unchecked it",
        scope: ["user:universal"],
        confidence: 0.7,
        epistemic_status: "active",
        aliases: [],
      },
    ],
    belief_updates: [],
  });

  const adapter = makeAdapter({ content: extractionResponse });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "Something" },
  ];

  const completeRes = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  const { draft_id } = JSON.parse(completeRes.body);

  const kept = [
    {
      type: "preference",
      canonical_name: "original",
      content: "original content",
      why_it_matters: "matters",
      scope: ["user:universal"],
      confidence: 0.9,
    },
  ];

  const commitRes = await app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft_id, edited_beliefs: kept }),
  });

  t.is(commitRes.statusCode, 200);

  const enqueueCall = (deps.jobs.enqueueOnboarding as sinon.SinonStub)
    .firstCall;
  const sidecar = JSON.parse(enqueueCall.args[0].sidecarRaw);
  t.is(sidecar.new_beliefs.length, 1);
  t.is(sidecar.new_beliefs[0].canonical_name, "original");
});

test("POST /v1/onboarding/commit triggers inline extraction", async (t) => {
  const extractionResponse = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "preference",
        canonical_name: "x",
        content: "y",
        why_it_matters: "z",
        scope: ["user:universal"],
        confidence: 0.9,
        epistemic_status: "active",
        aliases: [],
      },
    ],
    belief_updates: [],
  });

  const adapter = makeAdapter({ content: extractionResponse });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "Quick" },
  ];

  const completeRes = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  const { draft_id } = JSON.parse(completeRes.body);

  await app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft_id }),
  });

  t.true(
    (deps.extractionWorker.processById as sinon.SinonStub).calledOnceWith(
      "job-123",
    ),
  );
});

test("POST /v1/onboarding/commit draft can only be used once", async (t) => {
  const extractionResponse = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [
      {
        type: "preference",
        canonical_name: "x",
        content: "y",
        why_it_matters: "z",
        scope: ["user:universal"],
        confidence: 0.9,
        epistemic_status: "active",
        aliases: [],
      },
    ],
    belief_updates: [],
  });

  const adapter = makeAdapter({ content: extractionResponse });
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const answers = [
    { question_id: "response_length", question: "Q", answer: "Short" },
  ];

  const completeRes = await app.inject({
    method: "POST",
    url: "/v1/onboarding/complete",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  const { draft_id } = JSON.parse(completeRes.body);

  const first = await app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft_id }),
  });
  t.is(first.statusCode, 200);

  const second = await app.inject({
    method: "POST",
    url: "/v1/onboarding/commit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft_id }),
  });
  t.is(second.statusCode, 404);
});

test("GET /v1/onboarding/probe-models/:id returns models for configured provider", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: `/v1/onboarding/probe-models/${PROVIDER_ID}`,
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.supports_listing);
  t.true(body.models.length >= 1);
  t.truthy(body.models[0].id);
});

test("GET /v1/onboarding/probe-models/:id returns 404 for unknown provider", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: "/v1/onboarding/probe-models/nonexistent",
  });

  t.is(res.statusCode, 404);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /not configured/);
});

test("GET /v1/onboarding/probe-models/:id annotates tier info on each model", async (t) => {
  const res = await t.context.app.inject({
    method: "GET",
    url: `/v1/onboarding/probe-models/${PROVIDER_ID}`,
  });

  const body = JSON.parse(res.body);
  const model = body.models[0];
  t.true("supported" in model);
  t.true("family" in model);
  t.true("tier" in model);
});

test("POST /v1/onboarding/validate-model returns 400 for missing fields", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/validate-model",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: PROVIDER_ID }),
  });

  t.is(res.statusCode, 400);
});

test("POST /v1/onboarding/validate-model pings model and saves default", async (t) => {
  const res = await t.context.app.inject({
    method: "POST",
    url: "/v1/onboarding/validate-model",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: PROVIDER_ID, model_id: MODEL }),
  });

  t.is(res.statusCode, 200);
  const body = JSON.parse(res.body);
  t.true(body.ok);
  t.true(
    (t.context.deps.runtimeStore.set as sinon.SinonStub).calledWith(
      "default_model",
      MODEL,
    ),
  );
});

test("POST /v1/onboarding/validate-model returns 502 when ping fails", async (t) => {
  const adapter: ProviderAdapter = {
    id: PROVIDER_ID,
    call: sinon.stub().rejects(new Error("model not found")),
  };
  const { deps } = makeDeps(adapter);
  const app = buildApp(deps);

  const res = await app.inject({
    method: "POST",
    url: "/v1/onboarding/validate-model",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: PROVIDER_ID, model_id: "bad-model" }),
  });

  t.is(res.statusCode, 502);
  const body = JSON.parse(res.body);
  t.regex(body.error.message, /ping failed/);
});

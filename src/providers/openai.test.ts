import test from "ava";
import sinon from "sinon";
import { OpenAIAdapter, ProviderError } from "./openai.js";
import type { NormalizedRequest } from "./types.js";

const BASE_REQ: NormalizedRequest = {
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hi" }],
};

const MOCK_BODY = {
  model: "gpt-4o",
  choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test.afterEach(() => sinon.restore());

test.serial("call() maps response to NormalizedResponse", async (t) => {
  sinon.stub(globalThis, "fetch").resolves(jsonResponse(MOCK_BODY));
  const result = await new OpenAIAdapter("key").call(BASE_REQ, "");

  t.is(result.content, "Hello!");
  t.is(result.provider, "openai");
  t.is(result.finish_reason, "stop");
  t.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test.serial("call() sets Bearer authorization header", async (t) => {
  const fetchStub = sinon
    .stub(globalThis, "fetch")
    .resolves(jsonResponse(MOCK_BODY));
  await new OpenAIAdapter("my-secret").call(BASE_REQ, "");

  const headers = fetchStub.firstCall.args[1]?.headers as Record<
    string,
    string
  >;
  t.is(headers["authorization"], "Bearer my-secret");
});

test.serial(
  "call() merges injected system prompt with existing system message",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      {
        ...BASE_REQ,
        messages: [
          { role: "system", content: "Base" },
          { role: "user", content: "Hi" },
        ],
      },
      "Injected",
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.messages[0].role, "system");
    t.is(body.messages[0].content, "Injected\n\nBase");
  },
);

test.serial(
  "call() omits system message when both system sources are empty",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(BASE_REQ, "");

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.messages[0].role, "user");
  },
);

test.serial(
  "call() forwards model, temperature, max_tokens, stream=false",
  async (t) => {
    const fetchStub = sinon
      .stub(globalThis, "fetch")
      .resolves(jsonResponse(MOCK_BODY));
    await new OpenAIAdapter("key").call(
      { ...BASE_REQ, temperature: 0.7, max_tokens: 256 },
      "",
    );

    const body = JSON.parse(fetchStub.firstCall.args[1]?.body as string);
    t.is(body.model, "gpt-4o");
    t.is(body.temperature, 0.7);
    t.is(body.max_tokens, 256);
    t.false(body.stream);
  },
);

test.serial("call() throws ProviderError on non-2xx response", async (t) => {
  sinon.stub(globalThis, "fetch").resolves(jsonResponse({ error: "bad" }, 400));
  const err = await t.throwsAsync(
    () => new OpenAIAdapter("key").call(BASE_REQ, ""),
    { instanceOf: ProviderError },
  );
  t.regex(err!.message, /400/);
});

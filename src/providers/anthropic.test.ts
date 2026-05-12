import test from "ava";
import sinon from "sinon";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAdapter } from "./anthropic.js";
import type { NormalizedRequest } from "./types.js";

const BASE_REQ: NormalizedRequest = {
  model: "claude-3-5-sonnet-20241022",
  messages: [{ role: "user", content: "Hi" }],
};

const MOCK_RESPONSE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-3-5-sonnet-20241022",
  stop_reason: "end_turn",
  stop_sequence: null,
  content: [{ type: "text", text: "Hello!" }],
  usage: { input_tokens: 10, output_tokens: 5 },
} as unknown as Anthropic.Message;

const makeSdkError = (Cls: {
  prototype: InstanceType<typeof Anthropic.APIError>;
}) => Object.create(Cls.prototype) as InstanceType<typeof Anthropic.APIError>;

const stubCreate = (adapter: AnthropicAdapter) =>
  sinon.stub((adapter as any).client.messages, "create");

test.afterEach(() => sinon.restore());

test("call() returns normalized response", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).resolves(MOCK_RESPONSE);

  const result = await adapter.call(BASE_REQ, "You are helpful");

  t.is(result.content, "Hello!");
  t.is(result.provider, "anthropic");
  t.is(result.model, "claude-3-5-sonnet-20241022");
  t.is(result.finish_reason, "stop");
  t.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
});

test("call() merges injected system prompt with existing system message", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(
    {
      ...BASE_REQ,
      messages: [
        { role: "system", content: "Existing" },
        { role: "user", content: "Hi" },
      ],
    },
    "Injected",
  );

  const params = createStub.firstCall.args[0] as any;
  t.is(params.system, "Injected\n\nExisting");
});

test("call() omits system field when both sources are empty", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(BASE_REQ, "");

  t.false("system" in createStub.firstCall.args[0]);
});

const stopReasonMacro = test.macro<[stopReason: string, expected: string]>(
  async (t, stopReason, expected) => {
    const adapter = new AnthropicAdapter("key");
    stubCreate(adapter).resolves({ ...MOCK_RESPONSE, stop_reason: stopReason });
    const result = await adapter.call(BASE_REQ, "");
    t.is(result.finish_reason, expected);
  },
);

test("stop_reason end_turn → stop", stopReasonMacro, "end_turn", "stop");
test(
  "stop_reason max_tokens → length",
  stopReasonMacro,
  "max_tokens",
  "length",
);
test(
  "stop_reason stop_sequence → stop",
  stopReasonMacro,
  "stop_sequence",
  "stop",
);
test(
  "stop_reason tool_use → tool_calls",
  stopReasonMacro,
  "tool_use",
  "tool_calls",
);

test("call() extracts tool_use blocks into toolCalls", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).resolves({
    ...MOCK_RESPONSE,
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: "tu_01",
        name: "get_weather",
        input: { location: "NYC" },
      },
    ],
  });

  const result = await adapter.call(BASE_REQ, "");
  const tc = (result.toolCalls as any[])[0];

  t.is(tc.id, "tu_01");
  t.is(tc.type, "function");
  t.is(tc.function.name, "get_weather");
  t.deepEqual(JSON.parse(tc.function.arguments), { location: "NYC" });
});

test("call() converts tool role messages to tool_result blocks", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(
    {
      ...BASE_REQ,
      messages: [{ role: "tool", content: "42°F", tool_call_id: "tc_01" }],
    },
    "",
  );

  const [msg] = createStub.firstCall.args[0].messages;
  t.is(msg.role, "user");
  t.is(msg.content[0].type, "tool_result");
  t.is(msg.content[0].tool_use_id, "tc_01");
  t.is(msg.content[0].content, "42°F");
});

test("call() translates OAI tools to Anthropic input_schema format", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const createStub = stubCreate(adapter).resolves(MOCK_RESPONSE);

  await adapter.call(
    {
      ...BASE_REQ,
      passThrough: {
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    },
    "",
  );

  const [tool] = createStub.firstCall.args[0].tools;
  t.is(tool.name, "get_weather");
  t.is(tool.description, "Get current weather");
  t.deepEqual(tool.input_schema, { type: "object", properties: {} });
});

test("call() maps AuthenticationError to friendly message", async (t) => {
  const adapter = new AnthropicAdapter("bad-key");
  stubCreate(adapter).rejects(makeSdkError(Anthropic.AuthenticationError));

  const err = await t.throwsAsync(() => adapter.call(BASE_REQ, ""));
  t.regex(err!.message, /authentication failed/i);
});

test("call() maps RateLimitError to friendly message", async (t) => {
  const adapter = new AnthropicAdapter("key");
  stubCreate(adapter).rejects(makeSdkError(Anthropic.RateLimitError));

  const err = await t.throwsAsync(() => adapter.call(BASE_REQ, ""));
  t.regex(err!.message, /rate limit/i);
});

test("call() maps generic APIError with status code", async (t) => {
  const adapter = new AnthropicAdapter("key");
  const sdkErr = Object.assign(makeSdkError(Anthropic.APIError), {
    status: 503,
    message: "Service unavailable",
  });
  stubCreate(adapter).rejects(sdkErr);

  const err = await t.throwsAsync(() => adapter.call(BASE_REQ, ""));
  t.regex(err!.message, /503/);
});

import { SIDECAR_BEGIN, SIDECAR_END } from "../sidecar/splitter.js";

export interface FixtureTurn {
  label: string;
  userMessage: string;
  providerContent: string;
  expect: {
    visible: string;
    parseStatus: "parsed" | "needs_repair" | "missing";
    turnSignal:
      | "substantive"
      | "acknowledgment"
      | "clarification"
      | "correction";
    hasNewBeliefs: boolean;
    hasOpenQuestion: boolean;
    hasCodeBlock?: boolean;
  };
}

export interface Scenario {
  id: string;
  name: string;
  turns: FixtureTurn[];
  expectAfterAll: {
    turnCount: number;
    jobCount: number;
  };
}

function sc(payload: object): string {
  return `\n${SIDECAR_BEGIN}\n${JSON.stringify(payload)}\n${SIDECAR_END}`;
}

function scTruncated(payload: object): string {
  return `\n${SIDECAR_BEGIN}\n${JSON.stringify(payload)}`;
}

const EMPTY_SIDECAR = {
  new_beliefs: [],
  belief_updates: [],
  new_open_questions: [],
};

export const SCENARIOS: Scenario[] = [
  {
    id: "belief-extraction",
    name: "beliefs and open questions detected through full pipeline",
    turns: [
      {
        label: "user introduces project",
        userMessage: "I'm building a REST API in TypeScript with Fastify.",
        providerContent:
          "Great choice! Fastify offers first-class TypeScript support." +
          sc({
            turn_signal: "substantive",
            new_beliefs: [
              {
                type: "FACT",
                canonical_name: "project-stack",
                content: "REST API in TypeScript with Fastify",
                why_it_matters: "Core project context",
                scope: ["coding"],
                confidence: 0.95,
              },
            ],
            belief_updates: [],
            new_open_questions: [],
          }),
        expect: {
          visible:
            "Great choice! Fastify offers first-class TypeScript support.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: true,
          hasOpenQuestion: false,
        },
      },
      {
        label: "user states preference",
        userMessage: "I prefer composition over inheritance.",
        providerContent:
          "Solid principle — more flexible and testable." +
          sc({
            turn_signal: "substantive",
            new_beliefs: [
              {
                type: "PREFERENCE",
                canonical_name: "composition-over-inheritance",
                content: "Prefers composition over inheritance",
                why_it_matters: "Affects class design suggestions",
                scope: ["coding"],
                confidence: 0.9,
              },
            ],
            belief_updates: [],
            new_open_questions: [],
          }),
        expect: {
          visible: "Solid principle — more flexible and testable.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: true,
          hasOpenQuestion: false,
        },
      },
      {
        label: "user asks open question",
        userMessage: "Should I use PostgreSQL or MongoDB?",
        providerContent:
          "It depends on your data model. PostgreSQL excels with relational data; MongoDB with documents." +
          sc({
            turn_signal: "substantive",
            new_beliefs: [],
            belief_updates: [],
            new_open_questions: [
              {
                canonical_name: "database-choice",
                content: "PostgreSQL vs MongoDB",
                scope: ["coding"],
              },
            ],
          }),
        expect: {
          visible:
            "It depends on your data model. PostgreSQL excels with relational data; MongoDB with documents.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: true,
        },
      },
    ],
    expectAfterAll: { turnCount: 3, jobCount: 3 },
  },

  {
    id: "ack-sequence",
    name: "acknowledgment turns are classified correctly for compaction",
    turns: [
      {
        label: "substantive exchange",
        userMessage: "How do I add CORS to Fastify?",
        providerContent:
          "Use @fastify/cors — install and register on your instance." +
          sc({ turn_signal: "substantive", ...EMPTY_SIDECAR }),
        expect: {
          visible: "Use @fastify/cors — install and register on your instance.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
      {
        label: "first ack",
        userMessage: "Got it, thanks!",
        providerContent:
          "You're welcome!" +
          sc({ turn_signal: "acknowledgment", ...EMPTY_SIDECAR }),
        expect: {
          visible: "You're welcome!",
          parseStatus: "parsed",
          turnSignal: "acknowledgment",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
      {
        label: "second ack",
        userMessage: "OK",
        providerContent:
          "\u{1F44D}" + sc({ turn_signal: "acknowledgment", ...EMPTY_SIDECAR }),
        expect: {
          visible: "\u{1F44D}",
          parseStatus: "parsed",
          turnSignal: "acknowledgment",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
      {
        label: "new substantive turn",
        userMessage: "How do I add rate limiting?",
        providerContent:
          "Use @fastify/rate-limit." +
          sc({ turn_signal: "substantive", ...EMPTY_SIDECAR }),
        expect: {
          visible: "Use @fastify/rate-limit.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
    ],
    expectAfterAll: { turnCount: 4, jobCount: 4 },
  },

  {
    id: "correction-flow",
    name: "correction signal is preserved and belief_updates are captured",
    turns: [
      {
        label: "initial misunderstanding",
        userMessage: "Help me set up the web framework",
        providerContent:
          "Let's set up Express! Run npm install express." +
          sc({
            turn_signal: "substantive",
            new_beliefs: [
              {
                type: "FACT",
                canonical_name: "web-framework",
                content: "Using Express",
                why_it_matters: "Core framework",
                scope: ["coding"],
                confidence: 0.7,
              },
            ],
            belief_updates: [],
            new_open_questions: [],
          }),
        expect: {
          visible: "Let's set up Express! Run npm install express.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: true,
          hasOpenQuestion: false,
        },
      },
      {
        label: "user corrects",
        userMessage:
          "No — Fastify, not Express. We decided on Fastify last week.",
        providerContent:
          "Apologies! Let's set up Fastify instead." +
          sc({
            turn_signal: "correction",
            new_beliefs: [],
            belief_updates: [
              {
                belief_id: "web-framework",
                change: "supersede",
                new_content: "Using Fastify",
              },
            ],
            new_open_questions: [],
          }),
        expect: {
          visible: "Apologies! Let's set up Fastify instead.",
          parseStatus: "parsed",
          turnSignal: "correction",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
    ],
    expectAfterAll: { turnCount: 2, jobCount: 2 },
  },

  {
    id: "long-ack-promotion",
    name: "acknowledgment with >100 token user message is promoted to substantive",
    turns: [
      {
        label: "setup",
        userMessage: "Tell me about error handling patterns",
        providerContent:
          "Several approaches exist in Node.js..." +
          sc({ turn_signal: "substantive", ...EMPTY_SIDECAR }),
        expect: {
          visible: "Several approaches exist in Node.js...",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
      {
        label: "long message the LLM mis-classifies as ack",
        userMessage:
          "Got it, that makes sense. But I want to elaborate on what I need " +
          "specifically. In our current codebase we have a middleware chain " +
          "that catches errors at three levels: the route handler level, the " +
          "service layer level, and the repository level. Each level has its " +
          "own error classification scheme and I need to unify them into a " +
          "single error taxonomy that can be serialized to JSON for the API " +
          "response while also being logged with full stack traces internally. " +
          "The current approach is a mess of try-catch blocks.",
        providerContent:
          "I see — you need a unified error taxonomy." +
          sc({ turn_signal: "acknowledgment", ...EMPTY_SIDECAR }),
        expect: {
          visible: "I see — you need a unified error taxonomy.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
    ],
    expectAfterAll: { turnCount: 2, jobCount: 2 },
  },

  {
    id: "sidecar-edge-cases",
    name: "truncated and missing sidecars are handled gracefully",
    turns: [
      {
        label: "well-formed sidecar",
        userMessage: "Capital of France?",
        providerContent:
          "Paris." + sc({ turn_signal: "substantive", ...EMPTY_SIDECAR }),
        expect: {
          visible: "Paris.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
      {
        label: "truncated sidecar — no END marker",
        userMessage: "And Germany?",
        providerContent:
          "Berlin." +
          scTruncated({
            turn_signal: "clarification",
            ...EMPTY_SIDECAR,
          }),
        expect: {
          visible: "Berlin.",
          parseStatus: "needs_repair",
          turnSignal: "clarification",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
      {
        label: "no sidecar at all",
        userMessage: "And Spain?",
        providerContent: "Madrid.",
        expect: {
          visible: "Madrid.",
          parseStatus: "missing",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
        },
      },
    ],
    expectAfterAll: { turnCount: 3, jobCount: 3 },
  },

  {
    id: "code-in-response",
    name: "code fences are flagged and sidecar after code is parsed correctly",
    turns: [
      {
        label: "user asks for code",
        userMessage: "Show me a Fastify hello world",
        providerContent:
          "Here's a minimal server:\n\n" +
          "```typescript\n" +
          'import Fastify from "fastify";\n' +
          "const app = Fastify();\n" +
          'app.get("/", async () => ({ hello: "world" }));\n' +
          "await app.listen({ port: 3000 });\n" +
          "```\n\n" +
          "This creates a server on port 3000." +
          sc({ turn_signal: "substantive", ...EMPTY_SIDECAR }),
        expect: {
          visible:
            "Here's a minimal server:\n\n" +
            "```typescript\n" +
            'import Fastify from "fastify";\n' +
            "const app = Fastify();\n" +
            'app.get("/", async () => ({ hello: "world" }));\n' +
            "await app.listen({ port: 3000 });\n" +
            "```\n\n" +
            "This creates a server on port 3000.",
          parseStatus: "parsed",
          turnSignal: "substantive",
          hasNewBeliefs: false,
          hasOpenQuestion: false,
          hasCodeBlock: true,
        },
      },
    ],
    expectAfterAll: { turnCount: 1, jobCount: 1 },
  },
];

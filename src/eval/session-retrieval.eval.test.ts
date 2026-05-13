import test from "ava";
import { execSync, spawnSync } from "node:child_process";
import { MongoClient, type Collection, type Db } from "mongodb";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BeliefsReader } from "../context/beliefsReader.js";
import {
  ContextBuilder,
  type PersonaLookup,
} from "../context/contextBuilder.js";
import type { Belief } from "../types/belief.js";
import type { Turn, TurnSignal } from "../history/manager.js";

interface BeliefsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
  shouldOnlyInclude?: string[];
}

interface PinnedFactsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
}

interface QuestionsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
}

interface NoiseCheck {
  mustNotSurface: string[];
}

interface SessionTurnExpect {
  relevantBeliefs?: BeliefsExpect;
  pinnedFacts?: PinnedFactsExpect;
  openQuestions?: QuestionsExpect;
  noiseCheck?: NoiseCheck;
}

interface SessionTurn {
  turnIndex: number;
  label: "establishes_topic" | "drift" | "implicit_continuation" | "re_entry";
  scope: string[];
  userMessage: string;
  assistantMessage: string;
  createBeliefAtTurn?: Record<string, unknown>;
  updateBeliefAtTurn?: {
    beliefId: string;
    addAliases?: string[];
    setContent?: string;
    setCanonicalName?: string;
    _note?: string;
  };
  turnSignal: TurnSignal;
  topics: string[];
  expect: SessionTurnExpect;
}

interface SessionEvalCase {
  caseId: string;
  description: string;
  turns: SessionTurn[];
  notes?: string;
}

interface SessionReportEntry {
  caseId: string;
  turnIndex: number;
  label: string;
  expandedQuery: string;
  retrievedBeliefIds: string[];
  pinnedBeliefIds: string[];
  noiseBeliefIds: string[];
  driftScore: number;
  passed: boolean;
  failures: string[];
  searchScores: FlatSearchScore[];
}

interface ScoreClause {
  path: string;
  term: string;
  score: number;
}

interface ScoreNode {
  value: number;
  description: string;
  details: ScoreNode[];
}

interface FlatSearchScore {
  id: string;
  score: number;
  clauses: ScoreClause[];
}

const BM25_SINGLE = /\$type:string\/([^:]+):(\S+?)(?:\s+in\s|\s*\[)/;
const BM25_PHRASE = /\$multi\/([^:]+):(.+?)(?:\s+in\s|\s*\[)/;
const TOKEN_CLAUSE = /\$type:token\//;

function extractClauses(node: ScoreNode): ScoreClause[] {
  if (TOKEN_CLAUSE.test(node.description)) return [];
  const single = BM25_SINGLE.exec(node.description);
  if (single) {
    return [
      {
        path: single[1],
        term: single[2],
        score: Math.round(node.value * 100) / 100,
      },
    ];
  }
  const phrase = BM25_PHRASE.exec(node.description);
  if (phrase) {
    return [
      {
        path: phrase[1],
        term: phrase[2],
        score: Math.round(node.value * 100) / 100,
      },
    ];
  }
  return node.details.flatMap(extractClauses);
}

const ATLAS_IMAGE = "mongodb/mongodb-atlas-local:8";
const CONTAINER_NAME = "memory-eval-session-atlas";
const HOST_PORT = 27020;
const MONGO_URI = `mongodb://localhost:${HOST_PORT}/?directConnection=true`;

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

const USER_ID = "test-user";
const FIXTURE_BELIEFS = resolve("src/__fixtures__/beliefs.seed.json");
const FIXTURE_SESSION_CASES = resolve(
  "src/__fixtures__/session-retrieval.cases.json",
);
const REPORT_DIR = resolve("test-results");
const REPORT_PATH = resolve(REPORT_DIR, "session-retrieval-report.json");

const DATE_FIELDS = [
  "created_at",
  "updated_at",
  "last_reinforced_at",
  "resolved_at",
] as const;

const EVAL_PERSONA: PersonaLookup = {
  get: async (userId: string) =>
    userId === USER_ID
      ? {
          universal:
            "You prefer direct answers without preamble. You push back when plans have problems rather than defaulting to agreement. You edit AI output; you do not let AI edit your prose.",
          per_scope: {
            "domain:code":
              "You work in TypeScript with strict mode, Fastify for HTTP, and MongoDB with the raw driver — never an ORM. You prefer composition over inheritance and Go-style explicit error returns.",
            "domain:writing":
              "You write close third-person, present tense, set in 1970s Lisbon. No omniscient asides, no reconciliation arcs.",
          },
        }
      : null,
};

function containerExists(): boolean {
  const result = spawnSync("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^${CONTAINER_NAME}$`,
    "--format",
    "{{.Names}}",
  ]);
  return result.stdout.toString().trim() === CONTAINER_NAME;
}

function containerRunning(): boolean {
  const result = spawnSync("docker", [
    "ps",
    "--filter",
    `name=^${CONTAINER_NAME}$`,
    "--format",
    "{{.Names}}",
  ]);
  return result.stdout.toString().trim() === CONTAINER_NAME;
}

function startContainer(): void {
  if (containerRunning()) return;
  if (containerExists()) {
    execSync(`docker start ${CONTAINER_NAME}`, { stdio: "pipe" });
    return;
  }
  execSync(
    [
      "docker run -d",
      `--name ${CONTAINER_NAME}`,
      `-p ${HOST_PORT}:27017`,
      ATLAS_IMAGE,
    ].join(" "),
    { stdio: "pipe" },
  );
}

function stopContainer(): void {
  if (containerExists()) {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
  }
}

async function waitForMongo(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const c = new MongoClient(MONGO_URI, {
        serverSelectionTimeoutMS: READY_POLL_MS,
      });
      await c.connect();
      await c.db("admin").command({ ping: 1 });
      await c.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  throw new Error(
    `Atlas Local container did not become ready within ${READY_TIMEOUT_MS}ms`,
  );
}

async function retryUntilReady<T>(
  fn: () => Promise<T>,
  label: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  throw new Error(
    `${label} did not succeed within ${timeoutMs}ms — last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

function coerceBelief(raw: Record<string, unknown>): Belief {
  const out: Record<string, unknown> = { ...raw };
  for (const f of DATE_FIELDS) {
    const v = out[f];
    if (typeof v === "string") out[f] = new Date(v);
  }
  const prov = out.provenance as Record<string, unknown> | undefined;
  if (prov?.extracted_at && typeof prov.extracted_at === "string") {
    prov.extracted_at = new Date(prov.extracted_at);
  }
  return out as unknown as Belief;
}

let client: MongoClient;
let db: Db;
let beliefsCol: Collection<Belief>;
let turnsCol: Collection<Turn>;
const sessionReport: SessionReportEntry[] = [];

test.before(async () => {
  startContainer();
  await waitForMongo();

  client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("session_eval_isolated");
  beliefsCol = db.collection<Belief>("beliefs");
  turnsCol = db.collection<Turn>("turns");

  await beliefsCol.drop().catch(() => {});
  await db.createCollection("beliefs");

  await retryUntilReady(
    () =>
      beliefsCol.createSearchIndex({
        name: "beliefs_search",
        definition: {
          analyzer: "lucene.standard",
          analyzers: [
            {
              name: "aliases_light",
              tokenizer: { type: "whitespace" },
              tokenFilters: [
                { type: "lowercase" },
                { type: "englishPossessive" },
              ],
            },
            {
              name: "whole_name_analyzer",
              charFilters: [{ type: "mapping", mappings: { _: " " } }],
              tokenizer: {
                type: "regexCaptureGroup",
                pattern: "[^,;|]+",
                group: 0,
              },
              tokenFilters: [
                { type: "lowercase" },
                { type: "englishPossessive" },
              ],
            },
            {
              name: "canonical_query_search_analyzer",
              tokenizer: { type: "whitespace" },
              tokenFilters: [
                { type: "lowercase" },
                { type: "englishPossessive" },
                {
                  type: "stopword",
                  tokens: [
                    "a",
                    "an",
                    "the",
                    "and",
                    "or",
                    "in",
                    "of",
                    "to",
                    "for",
                    "with",
                    "our",
                    "my",
                    "we",
                    "i",
                    "on",
                    "at",
                    "by",
                    "up",
                    "their",
                    "its",
                    "is",
                    "are",
                    "was",
                    "be",
                    "that",
                    "this",
                    "how",
                    "what",
                    "does",
                  ],
                },
                {
                  type: "shingle",
                  minShingleSize: 2,
                  maxShingleSize: 2,
                },
              ],
            },
            {
              name: "alias_search_analyzer",
              tokenizer: { type: "whitespace" },
              tokenFilters: [
                { type: "lowercase" },
                { type: "englishPossessive" },
                {
                  type: "shingle",
                  minShingleSize: 2,
                  maxShingleSize: 2,
                },
              ],
            },
          ],
          mappings: {
            dynamic: false,
            fields: {
              _id: { type: "token" },
              user_id: { type: "token" },
              canonical_name: {
                type: "string",
                analyzer: "whole_name_analyzer",
                searchAnalyzer: "lucene.standard",
                multi: {
                  phrase: {
                    type: "string",
                    analyzer: "whole_name_analyzer",
                    searchAnalyzer: "canonical_query_search_analyzer",
                  },
                },
              },
              aliases: {
                type: "string",
                analyzer: "whole_name_analyzer",
                searchAnalyzer: "aliases_light",
                multi: {
                  shingle: {
                    type: "string",
                    analyzer: "whole_name_analyzer",
                    searchAnalyzer: "alias_search_analyzer",
                  },
                },
              },
              content: { type: "string", analyzer: "lucene.english" },
              superseded_by: { type: "token" },
              resolved_at: { type: "date" },
              type: { type: "token" },
              scope: { type: "token" },
              reinforcement_count: { type: "number" },
              confidence: { type: "number" },
              subtype: { type: "token" },
            },
          },
        },
      }),
    "createBeliefsSearchIndex",
    60_000,
  );

  await retryUntilReady(
    async () => {
      const indexes = await beliefsCol.listSearchIndexes().toArray();
      const idx = indexes.find((i) => i.name === "beliefs_search") as
        | Record<string, unknown>
        | undefined;
      if (idx?.status !== "READY") throw new Error(`status: ${idx?.status}`);
    },
    "waitForBeliefsSearchIndex",
    60_000,
  );

  const rawBeliefs = JSON.parse(
    readFileSync(FIXTURE_BELIEFS, "utf8"),
  ) as Record<string, unknown>[];
  await beliefsCol.insertMany(rawBeliefs.map(coerceBelief));

  await retryUntilReady(
    async () => {
      const results = await beliefsCol
        .aggregate([
          {
            $search: {
              index: "beliefs_search",
              text: { query: "TypeScript", path: "aliases" },
            },
          },
          { $limit: 1 },
        ])
        .toArray();
      if (results.length === 0)
        throw new Error("Beliefs search index not synced");
    },
    "waitForBeliefsSearchSync",
    READY_TIMEOUT_MS,
  );

  await turnsCol.drop().catch(() => {});
  await db.createCollection("turns");

  await retryUntilReady(
    () =>
      turnsCol.createSearchIndex({
        name: "turns_search",
        definition: {
          analyzer: "lucene.standard",
          mappings: {
            dynamic: false,
            fields: {
              userId: { type: "token" },
              sessionId: { type: "token" },
              scope: { type: "token" },
              userMessage: { type: "string", analyzer: "lucene.standard" },
              assistantMessage: { type: "string", analyzer: "lucene.standard" },
            },
          },
        },
      }),
    "createTurnsSearchIndex",
    60_000,
  );

  await retryUntilReady(
    async () => {
      const indexes = await turnsCol.listSearchIndexes().toArray();
      const idx = indexes.find((i) => i.name === "turns_search") as
        | Record<string, unknown>
        | undefined;
      if (idx?.status !== "READY") throw new Error(`status: ${idx?.status}`);
    },
    "waitForTurnsSearchIndex",
    60_000,
  );
});

test.after.always(async () => {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(sessionReport, null, 2));
  await client?.close();
  stopContainer();
});

function makeTurnDoc(sessionId: string, turn: SessionTurn): Turn {
  return {
    _id: `${sessionId}-turn-${turn.turnIndex}`,
    sessionId,
    userId: USER_ID,
    turnIndex: turn.turnIndex,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    turnSignal: turn.turnSignal,
    hasOpenQuestion: false,
    hasNewBeliefs: false,
    hasBinaryContent: false,
    hasCodeBlock: turn.assistantMessage.includes("```"),
    scope: turn.scope,
    createdAt: new Date(Date.now() + turn.turnIndex * 60_000),
    state: "kept",
    topicId: turn.topics[0] ?? "default",
    topics: turn.topics,
    beliefCandidateIds: [],
    userRestored: false,
    tokenEstimate: Math.ceil(
      (turn.userMessage.length + turn.assistantMessage.length) / 3.5,
    ),
    collapsedBy: null,
    status: "complete",
    failureReason: null,
  };
}

async function waitForTurnsSearchSync(
  col: Collection<Turn>,
  sessionId: string,
  expectedCount: number,
): Promise<void> {
  await retryUntilReady(
    async () => {
      const results = await col
        .aggregate([
          {
            $search: {
              index: "turns_search",
              compound: {
                must: [
                  {
                    equals: {
                      path: "sessionId",
                      value: sessionId,
                    },
                  },
                  {
                    text: {
                      query: "the",
                      path: "userMessage",
                    },
                  },
                ],
              },
            },
          },
        ])
        .toArray();

      if (results.length < expectedCount) {
        throw new Error(
          `Turns search index has ${results.length} docs, expected >= ${expectedCount}`,
        );
      }
    },
    `waitForTurnsSearchSync(${sessionId}, ${expectedCount})`,
    30_000,
  );
}

function loadSessionCases(): SessionEvalCase[] {
  let raw: string;
  try {
    raw = readFileSync(FIXTURE_SESSION_CASES, "utf8");
  } catch (err) {
    throw new Error(
      `Session eval fixture not found at ${FIXTURE_SESSION_CASES}. ` +
        `Create the file with at least an empty array [].`,
    );
  }

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Session eval fixture must be a JSON array, got ${typeof parsed}`,
    );
  }
  return parsed as SessionEvalCase[];
}

const sessionCases = loadSessionCases();

for (const sessionCase of sessionCases) {
  test.serial(`session: ${sessionCase.caseId}`, async (t) => {
    const sessionId = `eval-session-${sessionCase.caseId}-${Date.now()}`;

    await turnsCol.deleteMany({ sessionId });

    const reader = new BeliefsReader(beliefsCol);
    const builder = new ContextBuilder(reader, EVAL_PERSONA, {
      scoreDetails: true,
    });

    let casePassedSoFar = true;

    for (const turn of sessionCase.turns) {
      if (turn.turnIndex > 0) {
        await waitForTurnsSearchSync(turnsCol, sessionId, turn.turnIndex);
      }

      const ctx = await builder.build(USER_ID, turn.scope, turn.userMessage);

      const pinned = JSON.parse(ctx.pinnedFactsJson) as Array<
        Record<string, unknown>
      >;
      const relevant = JSON.parse(ctx.relevantBeliefsJson) as Array<
        Record<string, unknown>
      >;
      const questions = JSON.parse(ctx.openQuestionsJson) as Array<
        Record<string, unknown>
      >;

      const pinnedIds = new Set(pinned.map((b) => b.id as string));
      const relevantIds = new Set(relevant.map((b) => b.id as string));
      const questionIds = new Set(questions.map((q) => q.id as string));

      const failures: string[] = [];
      const check = (cond: boolean, msg: string): void => {
        if (!cond) failures.push(msg);
      };

      const rb = turn.expect.relevantBeliefs;
      if (rb) {
        if (rb.shouldOnlyInclude) {
          const expectedSet = new Set(rb.shouldOnlyInclude);
          for (const id of relevantIds) {
            check(
              expectedSet.has(id),
              `turn ${turn.turnIndex}: unexpected relevant belief: ${id}`,
            );
          }
          for (const id of expectedSet) {
            check(
              relevantIds.has(id),
              `turn ${turn.turnIndex}: missing expected relevant belief: ${id}`,
            );
          }
        }
        for (const id of rb.mustInclude ?? []) {
          check(
            relevantIds.has(id) || pinnedIds.has(id),
            `turn ${turn.turnIndex}: missing expected belief: ${id}`,
          );
        }
        for (const id of rb.mustExclude ?? []) {
          check(
            !relevantIds.has(id) && !pinnedIds.has(id),
            `turn ${turn.turnIndex}: forbidden belief surfaced: ${id}`,
          );
        }
      }

      const pf = turn.expect.pinnedFacts;
      if (pf) {
        for (const id of pf.mustInclude ?? []) {
          check(
            pinnedIds.has(id),
            `turn ${turn.turnIndex}: missing pinned belief: ${id}`,
          );
        }
        for (const id of pf.mustExclude ?? []) {
          check(
            !pinnedIds.has(id),
            `turn ${turn.turnIndex}: forbidden pinned belief: ${id}`,
          );
        }
      }

      const oq = turn.expect.openQuestions;
      if (oq) {
        for (const id of oq.mustInclude ?? []) {
          check(
            questionIds.has(id),
            `turn ${turn.turnIndex}: missing expected question: ${id}`,
          );
        }
        for (const id of oq.mustExclude ?? []) {
          check(
            !questionIds.has(id),
            `turn ${turn.turnIndex}: forbidden question surfaced: ${id}`,
          );
        }
      }

      const noiseBeliefIds: string[] = [];
      const noiseCheck = turn.expect.noiseCheck;
      if (noiseCheck) {
        for (const id of noiseCheck.mustNotSurface) {
          if (relevantIds.has(id) || pinnedIds.has(id)) {
            noiseBeliefIds.push(id);
            failures.push(
              `turn ${turn.turnIndex}: noise belief surfaced: ${id}`,
            );
          }
        }
      }

      const totalSurfaced = relevantIds.size + pinnedIds.size;
      const driftScore =
        totalSurfaced === 0 ? 0 : noiseBeliefIds.length / totalSurfaced;

      sessionReport.push({
        caseId: sessionCase.caseId,
        turnIndex: turn.turnIndex,
        label: turn.label,
        expandedQuery: ctx.expandedQuery,
        retrievedBeliefIds: [...relevantIds],
        pinnedBeliefIds: [...pinnedIds],
        noiseBeliefIds,
        driftScore,
        passed: failures.length === 0,
        failures,
        searchScores: ctx.searchScores.map((s) => ({
          id: s.id,
          score: Math.round(s.score * 100) / 100,
          clauses: s.scoreDetails
            ? extractClauses(s.scoreDetails as ScoreNode, s.id)
            : [],
        })),
      });

      if (failures.length > 0) {
        casePassedSoFar = false;
      }

      const turnDoc = makeTurnDoc(sessionId, turn);
      await turnsCol.insertOne(turnDoc);

      if (turn.createBeliefAtTurn && turn.turnIndex === turn.turnIndex) {
        const beliefDoc = coerceBelief(
          turn.createBeliefAtTurn as Record<string, unknown>,
        );
        await beliefsCol.insertOne(beliefDoc);

        await turnsCol.updateOne(
          { _id: turnDoc._id },
          { $addToSet: { beliefCandidateIds: beliefDoc._id } },
        );

        const probeValue = beliefDoc.aliases[0];

        await retryUntilReady(
          async () => {
            const results = await beliefsCol
              .aggregate([
                {
                  $search: {
                    index: "beliefs_search",
                    compound: {
                      must: [
                        {
                          text: {
                            query: probeValue,
                            path: { value: "aliases", multi: "shingle" },
                          },
                        },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ])
              .toArray();
            if (results.length === 0)
              throw new Error(`Belief ${beliefDoc._id} not yet indexed`);
          },
          `waitForBeliefSync:${beliefDoc._id}`,
          READY_TIMEOUT_MS,
        );
      }

      if (turn.updateBeliefAtTurn) {
        const { beliefId, addAliases, setContent, setCanonicalName } =
          turn.updateBeliefAtTurn;

        const setFields: Record<string, unknown> = { updated_at: new Date() };
        if (setContent) setFields.content = setContent;
        if (setCanonicalName) setFields.canonical_name = setCanonicalName;

        if (Object.keys(setFields).length > 1) {
          await beliefsCol.updateOne({ _id: beliefId }, { $set: setFields });
        }

        if (addAliases && addAliases.length > 0) {
          const normalized = addAliases.map((a) => a.trim().toLowerCase());

          await beliefsCol.updateOne(
            { _id: beliefId },
            { $addToSet: { aliases: { $each: normalized } } },
          );
        }

        const probeAlias =
          addAliases && addAliases.length > 0
            ? addAliases[0].trim().toLowerCase()
            : (setCanonicalName ?? beliefId);

        await retryUntilReady(
          async () => {
            const results = await beliefsCol
              .aggregate([
                {
                  $search: {
                    index: "beliefs_search",
                    compound: {
                      must: [
                        {
                          text: {
                            query: probeAlias,
                            path: "aliases",
                          },
                        },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ])
              .toArray();
            if (results.length === 0)
              throw new Error(
                `Belief ${beliefId} alias "${probeAlias}" not yet indexed`,
              );
          },
          `waitForBeliefUpdateSync:${beliefId}`,
          READY_TIMEOUT_MS,
        );
      }
    }

    if (!casePassedSoFar) {
      const allFailures = sessionReport
        .filter((r) => r.caseId === sessionCase.caseId && !r.passed)
        .flatMap((r) => r.failures);
      t.fail(allFailures.join("\n"));
    } else {
      t.pass();
    }
  });
}

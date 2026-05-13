/**
 * session-retrieval.vector.eval.test.ts
 *
 * Vector-search equivalent of session-retrieval.test.ts.
 *
 * Runs the same session cases against $vectorSearch (nomic-embed-text via Ollama)
 * instead of BM25, producing a parallel report at:
 *   test-results/session-retrieval-report-vector.json
 *
 * The original session-retrieval.test.ts is untouched — run both together to
 * measure noise isolation under vector retrieval across a multi-turn drift session:
 *
 *   npx ava src/**\/*.test.ts
 *
 * Prerequisites:
 *   1. Run `npx tsx src/__fixtures__/embed-seed.ts` once to generate
 *      beliefs.seed.embedded.json (commit this file, don't regenerate at test time).
 *   2. Ollama must be running at OLLAMA_URL only for embed-seed.ts — not at test runtime.
 */

import test from "ava";
import { execSync, spawnSync } from "node:child_process";
import { MongoClient, type Collection, type Db } from "mongodb";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BeliefsReader } from "../context/beliefsReader.js";
import {
  BeliefsReaderVector,
  VECTOR_INDEX_NAME,
  VECTOR_DIMENSIONS,
  ollamaEmbed,
  beliefEmbedText,
} from "../context/beliefsReaderVector.js";
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
  searchScores: Array<{ id: string; score: number }>;
}

const ATLAS_IMAGE = "mongodb/mongodb-atlas-local:8";
const CONTAINER_NAME = "memory-eval-session-atlas-vector";
const HOST_PORT = 27021;
const MONGO_URI = `mongodb://localhost:${HOST_PORT}/?directConnection=true`;

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

const USER_ID = "test-user";
const FIXTURE_BELIEFS = resolve("src/__fixtures__/beliefs.seed.embedded.json");
const FIXTURE_SESSION_CASES = resolve(
  "src/__fixtures__/session-retrieval.cases.json",
);
const REPORT_DIR = resolve("test-results");
const REPORT_PATH = resolve(REPORT_DIR, "session-retrieval-report-vector.json");

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

function coerceBelief(
  raw: Record<string, unknown>,
): Belief & { embedding?: number[] } {
  const out: Record<string, unknown> = { ...raw };
  for (const f of DATE_FIELDS) {
    const v = out[f];
    if (typeof v === "string") out[f] = new Date(v);
  }
  const prov = out.provenance as Record<string, unknown> | undefined;
  if (prov?.extracted_at && typeof prov.extracted_at === "string") {
    prov.extracted_at = new Date(prov.extracted_at);
  }
  return out as unknown as Belief & { embedding?: number[] };
}

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
                  { equals: { path: "sessionId", value: sessionId } },
                  { text: { query: "the", path: "userMessage" } },
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

const embeddingCache = new Map<string, number[]>();

async function cachedEmbed(text: string): Promise<number[]> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;
  const vec = await ollamaEmbed(text);
  embeddingCache.set(text, vec);
  return vec;
}

let client: MongoClient;
let db: Db;
let beliefsCol: Collection<Belief & { embedding?: number[] }>;
let turnsCol: Collection<Turn>;
const sessionReport: SessionReportEntry[] = [];

test.before(async () => {
  startContainer();
  await waitForMongo();

  client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("session_eval_vector_isolated");
  beliefsCol = db.collection("beliefs");
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
              tokenizer: { type: "standard" },
              tokenFilters: [
                { type: "lowercase" },
                { type: "englishPossessive" },
                { type: "kStemming" },
              ],
            },
          ],
          mappings: {
            dynamic: false,
            fields: {
              user_id: { type: "token" },
              canonical_name: { type: "string", analyzer: "lucene.english" },
              aliases: { type: "string", analyzer: "aliases_light" },
              content: { type: "string", analyzer: "lucene.english" },
              superseded_by: { type: "token" },
              resolved_at: { type: "date" },
              type: { type: "token" },
              subtype: { type: "token" },
              scope: { type: "token" },
              reinforcement_count: { type: "number" },
              confidence: { type: "number" },
            },
          },
        },
      }),
    "createBeliefsSearchIndex(bm25)",
    60_000,
  );

  await retryUntilReady(
    () =>
      beliefsCol.createSearchIndex({
        name: VECTOR_INDEX_NAME,
        type: "vectorSearch",
        definition: {
          fields: [
            {
              type: "vector",
              path: "embedding",
              numDimensions: VECTOR_DIMENSIONS,
              similarity: "cosine",
            },
            { type: "filter", path: "user_id" },
            { type: "filter", path: "superseded_by" },
            { type: "filter", path: "resolved_at" },
          ],
        },
      } as Parameters<typeof beliefsCol.createSearchIndex>[0]),
    "createBeliefsSearchIndex(vector)",
    60_000,
  );

  await retryUntilReady(
    async () => {
      const indexes = (await beliefsCol.listSearchIndexes().toArray()) as Array<
        Record<string, unknown>
      >;
      const bm25 = indexes.find((i) => i.name === "beliefs_search");
      const vec = indexes.find((i) => i.name === VECTOR_INDEX_NAME);
      if (bm25?.status !== "READY")
        throw new Error(`beliefs bm25 status: ${bm25?.status}`);
      if (vec?.status !== "READY")
        throw new Error(`beliefs vector status: ${vec?.status}`);
    },
    "waitForBeliefsIndexes",
    60_000,
  );

  const rawBeliefs = JSON.parse(
    readFileSync(FIXTURE_BELIEFS, "utf8"),
  ) as Record<string, unknown>[];

  const first = rawBeliefs[0] as Record<string, unknown>;
  if (!Array.isArray(first?.embedding) || first.embedding.length === 0) {
    throw new Error(
      "beliefs.seed.embedded.json is missing embeddings. " +
        "Run `npx tsx src/__fixtures__/embed-seed.ts` first.",
    );
  }

  await beliefsCol.insertMany(rawBeliefs.map(coerceBelief));

  await retryUntilReady(
    async () => {
      const probe = await cachedEmbed("typescript");
      const results = await beliefsCol
        .aggregate([
          {
            $vectorSearch: {
              index: VECTOR_INDEX_NAME,
              path: "embedding",
              queryVector: probe,
              numCandidates: 10,
              limit: 1,
            },
          },
        ])
        .toArray();
      if (results.length === 0) throw new Error("vector index not synced yet");
    },
    "waitForBeliefsVectorSync",
    READY_TIMEOUT_MS,
  );

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
        throw new Error("beliefs BM25 index not synced");
    },
    "waitForBeliefsBM25Sync",
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
              assistantMessage: {
                type: "string",
                analyzer: "lucene.standard",
              },
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
      if (idx?.status !== "READY")
        throw new Error(`turns_search status: ${idx?.status}`);
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

function loadSessionCases(): SessionEvalCase[] {
  let raw: string;
  try {
    raw = readFileSync(FIXTURE_SESSION_CASES, "utf8");
  } catch {
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
  test.serial(`[vector] session: ${sessionCase.caseId}`, async (t) => {
    const sessionId = `eval-session-vector-${sessionCase.caseId}-${Date.now()}`;

    await turnsCol.deleteMany({ sessionId });

    const bm25Reader = new BeliefsReader(beliefsCol as Collection<Belief>);
    const vectorReader = new BeliefsReaderVector(beliefsCol, cachedEmbed);

    const compositeReader = {
      listPinnedFacts: bm25Reader.listPinnedFacts.bind(bm25Reader),
      listByScope: bm25Reader.listByScope.bind(bm25Reader),
      listPinnedOpenQuestions:
        bm25Reader.listPinnedOpenQuestions.bind(bm25Reader),
      countActive: bm25Reader.countActive.bind(bm25Reader),
      searchText: vectorReader.searchText.bind(vectorReader),
    } as unknown as BeliefsReader;

    const builder = new ContextBuilder(compositeReader, EVAL_PERSONA, {
      scoreDetails: false,
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
              `[vector] turn ${turn.turnIndex}: unexpected relevant belief: ${id}`,
            );
          }
          for (const id of expectedSet) {
            check(
              relevantIds.has(id),
              `[vector] turn ${turn.turnIndex}: missing expected relevant belief: ${id}`,
            );
          }
        }
        for (const id of rb.mustInclude ?? []) {
          check(
            relevantIds.has(id) || pinnedIds.has(id),
            `[vector] turn ${turn.turnIndex}: missing expected belief: ${id}`,
          );
        }
        for (const id of rb.mustExclude ?? []) {
          check(
            !relevantIds.has(id) && !pinnedIds.has(id),
            `[vector] turn ${turn.turnIndex}: forbidden belief surfaced: ${id}`,
          );
        }
      }

      const pf = turn.expect.pinnedFacts;
      if (pf) {
        for (const id of pf.mustInclude ?? []) {
          check(
            pinnedIds.has(id),
            `[vector] turn ${turn.turnIndex}: missing pinned belief: ${id}`,
          );
        }
        for (const id of pf.mustExclude ?? []) {
          check(
            !pinnedIds.has(id),
            `[vector] turn ${turn.turnIndex}: forbidden pinned belief: ${id}`,
          );
        }
      }

      const oq = turn.expect.openQuestions;
      if (oq) {
        for (const id of oq.mustInclude ?? []) {
          check(
            questionIds.has(id),
            `[vector] turn ${turn.turnIndex}: missing expected question: ${id}`,
          );
        }
        for (const id of oq.mustExclude ?? []) {
          check(
            !questionIds.has(id),
            `[vector] turn ${turn.turnIndex}: forbidden question surfaced: ${id}`,
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
              `[vector] turn ${turn.turnIndex}: noise belief surfaced: ${id}`,
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
          score: Math.round(s.score * 1000) / 1000,
        })),
      });

      if (failures.length > 0) {
        casePassedSoFar = false;
      }

      const turnDoc = makeTurnDoc(sessionId, turn);
      await turnsCol.insertOne(turnDoc);

      if (turn.createBeliefAtTurn) {
        const beliefDoc = coerceBelief(
          turn.createBeliefAtTurn as Record<string, unknown>,
        );

        const embedText = beliefEmbedText({
          canonical_name: beliefDoc.canonical_name as string,
          aliases: (beliefDoc.aliases as string[]) ?? [],
        });
        const embedding = await cachedEmbed(embedText);
        const beliefWithEmbedding = { ...beliefDoc, embedding };

        await beliefsCol.insertOne(
          beliefWithEmbedding as Belief & { embedding: number[] },
        );

        await turnsCol.updateOne(
          { _id: turnDoc._id },
          { $addToSet: { beliefCandidateIds: beliefDoc._id } },
        );

        await retryUntilReady(
          async () => {
            const probe = await cachedEmbed(beliefDoc.canonical_name as string);
            const results = await beliefsCol
              .aggregate([
                {
                  $vectorSearch: {
                    index: VECTOR_INDEX_NAME,
                    path: "embedding",
                    queryVector: probe,
                    numCandidates: 20,
                    limit: 5,
                    filter: { user_id: { $eq: USER_ID } },
                  },
                },
                { $match: { _id: beliefDoc._id } },
                { $limit: 1 },
              ])
              .toArray();
            if (results.length === 0)
              throw new Error(
                `Belief ${beliefDoc._id} not yet indexed in vector`,
              );
          },
          `waitForBeliefVectorSync:${beliefDoc._id}`,
          READY_TIMEOUT_MS,
        );
      }

      if (turn.updateBeliefAtTurn) {
        const { beliefId, addAliases, setContent, setCanonicalName } =
          turn.updateBeliefAtTurn;

        const existing = await beliefsCol.findOne({ _id: beliefId });
        if (!existing) {
          throw new Error(`updateBeliefAtTurn: belief ${beliefId} not found`);
        }

        const setFields: Record<string, unknown> = { updated_at: new Date() };
        if (setContent) setFields.content = setContent;
        if (setCanonicalName) setFields.canonical_name = setCanonicalName;

        if (Object.keys(setFields).length > 1) {
          await beliefsCol.updateOne({ _id: beliefId }, { $set: setFields });
        }

        const normalisedAliases =
          addAliases?.map((a) => a.trim().toLowerCase()) ?? [];

        if (normalisedAliases.length > 0) {
          await beliefsCol.updateOne(
            { _id: beliefId },
            { $addToSet: { aliases: { $each: normalisedAliases } } },
          );
        }

        const updatedCanonicalName =
          setCanonicalName ?? (existing.canonical_name as string);
        const updatedAliases = [
          ...new Set([
            ...((existing.aliases as string[]) ?? []),
            ...normalisedAliases,
          ]),
        ];

        const embedText = beliefEmbedText({
          canonical_name: updatedCanonicalName,
          aliases: updatedAliases,
        });

        const updatedEmbedding = await cachedEmbed(embedText);

        await beliefsCol.updateOne(
          { _id: beliefId },
          { $set: { embedding: updatedEmbedding } },
        );

        const probeText =
          normalisedAliases.length > 0
            ? normalisedAliases[0]
            : updatedCanonicalName;

        await retryUntilReady(
          async () => {
            const probeVec = await cachedEmbed(probeText);
            const results = await beliefsCol
              .aggregate([
                {
                  $vectorSearch: {
                    index: VECTOR_INDEX_NAME,
                    path: "embedding",
                    queryVector: probeVec,
                    numCandidates: 20,
                    limit: 5,
                    filter: { user_id: { $eq: USER_ID } },
                  },
                },
                { $match: { _id: beliefId } },
                { $limit: 1 },
              ])
              .toArray();
            if (results.length === 0)
              throw new Error(
                `Belief ${beliefId} not yet updated in vector index for probe "${probeText}"`,
              );
          },
          `waitForBeliefVectorUpdateSync:${beliefId}`,
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

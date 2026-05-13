import test from "ava";
import { execSync, spawnSync } from "node:child_process";
import { MongoClient, type Collection, type Db } from "mongodb";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { BeliefsReader } from "../context/beliefsReader.js";
import {
  ContextBuilder,
  type ContextBudget,
  type PersonaLookup,
} from "../context/contextBuilder.js";
import type { Belief } from "../types/belief.js";

interface PinnedFactsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
}

interface PreludeExpect {
  nonEmpty?: boolean;
  isNull?: boolean;
  contains?: string[];
  mustNotContain?: string[];
}

interface BeliefsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
  shouldInclude?: string[];
  shouldOnlyInclude?: string[];
  orderedBefore?: [string, string][];
  maxCount?: number;
  minCount?: number;
}

interface QuestionsExpect {
  mustInclude?: string[];
  mustExclude?: string[];
}

interface RetrievalCase {
  caseId: string;
  description: string;
  userId?: string;
  scope: string[];
  query: string;
  budget?: Partial<ContextBudget>;
  expect: {
    personaPrelude?: PreludeExpect;
    scopePrelude?: PreludeExpect;
    pinnedFacts?: PinnedFactsExpect;
    relevantBeliefs?: BeliefsExpect;
    openQuestions?: QuestionsExpect;
  };
  notes?: string;
}

interface ReportEntry {
  caseId: string;
  description: string;
  pinnedBeliefs: string[];
  relevantBeliefs: string[];
  retrievedQuestions: string[];
  expandedQuery: string;
  searchScores: FlatSearchScore[];
  retrievalPrecision: number | null;
  retrievalRecall: number | null;
  pinnedCoverage: number | null;
  questionPrecision: number | null;
  questionRecall: number | null;
  passed: boolean;
  failures: string[];
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

const BM25_MATCH =
  /\$(?:type:string|multi)\/([^:]+):([^\s\[]+(?:\s+[^\s\[]+)*)(?:\s+in\s|\[)/;
const TOKEN_CLAUSE = /\$type:token\//;

function extractClauses(node: ScoreNode): ScoreClause[] {
  if (TOKEN_CLAUSE.test(node.description)) return [];

  const m = BM25_MATCH.exec(node.description);
  if (m) {
    return [
      { path: m[1], term: m[2], score: Math.round(node.value * 100) / 100 },
    ];
  }

  return node.details.flatMap(extractClauses);
}

interface FlatSearchScore {
  id: string;
  score: number;
  clauses: ScoreClause[];
}

const ATLAS_IMAGE = "mongodb/mongodb-atlas-local:8";
const CONTAINER_NAME = "memory-eval-atlas";
const HOST_PORT = 27018;
const MONGO_URI = `mongodb://localhost:${HOST_PORT}/?directConnection=true`;

const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

const USER_ID = "test-user";
const FIXTURE_BELIEFS = resolve("src/__fixtures__/beliefs.seed.json");
const FIXTURE_CASES = resolve("src/__fixtures__/retrieval.cases.json");
const REPORT_DIR = resolve("test-results");
const REPORT_PATH = resolve(REPORT_DIR, "retrieval-report.json");

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
  if (containerRunning()) {
    return;
  }
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
    try {
      execSync(`docker volume rm ${CONTAINER_NAME}-data`, { stdio: "pipe" });
    } catch {
      // volume may not exist if container was run without one
    }
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

let client: MongoClient;
let db: Db;
let col: Collection<Belief>;
let pinnedInSeed: Set<string>;
const report: ReportEntry[] = [];

test.before(async () => {
  startContainer();
  await waitForMongo();

  client = new MongoClient(MONGO_URI);
  await client.connect();

  db = client.db("retrieval_eval_isolated");
  col = db.collection<Belief>("beliefs");

  await col.drop().catch(() => {});

  await db.createCollection("beliefs");

  await retryUntilReady(
    () =>
      col.createSearchIndex({
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
      const indexes = await col.listSearchIndexes().toArray();
      const idx = indexes.find((i) => i.name === "beliefs_search") as
        | Record<string, unknown>
        | undefined;
      if (idx?.status !== "READY") throw new Error(`status: ${idx?.status}`);
    },
    "waitForSearchIndex",
    60_000,
  );

  const raw = JSON.parse(readFileSync(FIXTURE_BELIEFS, "utf8")) as Record<
    string,
    unknown
  >[];
  await col.insertMany(raw.map(coerceBelief));

  await retryUntilReady(
    async () => {
      const results = await col
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
        throw new Error("Atlas Search index not synced");
    },
    "waitForSearchSync",
    READY_TIMEOUT_MS,
  );

  const pinnedDocs = await col
    .find({ user_id: USER_ID, pinned: true }, { projection: { _id: 1 } })
    .toArray();
  pinnedInSeed = new Set(pinnedDocs.map((d) => d._id as string));
});

test.after.always(async () => {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  await client?.close();
  stopContainer();
});

const cases = JSON.parse(
  readFileSync(FIXTURE_CASES, "utf8"),
) as RetrievalCase[];

for (const tc of cases) {
  test.serial(`${tc.caseId}: ${tc.description}`, async (t) => {
    const reader = new BeliefsReader(col);
    const builder = new ContextBuilder(reader, EVAL_PERSONA, {
      ...tc.budget,
      scoreDetails: true,
    });
    const ctx = await builder.build(tc.userId ?? USER_ID, tc.scope, tc.query);

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
    const unionIds = new Set<string>([...pinnedIds, ...relevantIds]);

    const failures: string[] = [];
    const check = (cond: boolean, msg: string): void => {
      if (!cond) failures.push(msg);
    };

    const rb = tc.expect.relevantBeliefs ?? {};
    for (const id of rb.mustInclude ?? []) {
      check(unionIds.has(id), `missing expected belief: ${id}`);
    }
    for (const id of rb.mustExclude ?? []) {
      check(!unionIds.has(id), `forbidden belief surfaced: ${id}`);
    }
    if (rb.maxCount != null) {
      check(
        relevantIds.size <= rb.maxCount,
        `relevantBeliefs count ${relevantIds.size} > maxCount ${rb.maxCount}`,
      );
    }
    if (rb.minCount != null) {
      check(
        relevantIds.size >= rb.minCount,
        `relevantBeliefs count ${relevantIds.size} < minCount ${rb.minCount}`,
      );
    }

    const onlyExpected = rb.shouldOnlyInclude;
    if (onlyExpected) {
      const expectedSet = new Set(onlyExpected);
      for (const id of relevantIds) {
        check(
          expectedSet.has(id),
          `unexpected belief in relevantBeliefs: ${id}`,
        );
      }
      for (const id of expectedSet) {
        check(relevantIds.has(id), `missing expected belief: ${id}`);
      }
    }

    const pf = tc.expect.pinnedFacts ?? {};
    for (const id of pf.mustInclude ?? []) {
      check(pinnedIds.has(id), `missing pinned belief: ${id}`);
    }
    for (const id of pf.mustExclude ?? []) {
      check(!pinnedIds.has(id), `forbidden belief in pinnedFacts: ${id}`);
    }

    for (const id of rb.shouldInclude ?? []) {
      check(unionIds.has(id), `expected belief missing (shouldInclude): ${id}`);
    }

    const relevantArray = relevant.map((r) => r.id as string);
    for (const [a, b] of rb.orderedBefore ?? []) {
      const idxA = relevantArray.indexOf(a);
      const idxB = relevantArray.indexOf(b);
      check(idxA !== -1, `orderedBefore: ${a} not in relevantBeliefs`);
      check(idxB !== -1, `orderedBefore: ${b} not in relevantBeliefs`);
      if (idxA !== -1 && idxB !== -1) {
        check(
          idxA < idxB,
          `ranking: ${a} (idx ${idxA}) should precede ${b} (idx ${idxB})`,
        );
      }
    }

    const oq = tc.expect.openQuestions ?? {};
    for (const id of oq.mustInclude ?? []) {
      check(questionIds.has(id), `missing expected question: ${id}`);
    }
    for (const id of oq.mustExclude ?? []) {
      check(!questionIds.has(id), `forbidden question surfaced: ${id}`);
    }

    const pp = tc.expect.personaPrelude;
    if (pp?.nonEmpty)
      check(ctx.personaPrelude.length > 0, "personaPrelude empty");
    if (pp?.isNull)
      check(ctx.personaPrelude === "", "personaPrelude not empty");
    for (const s of pp?.contains ?? []) {
      check(ctx.personaPrelude.includes(s), `personaPrelude missing "${s}"`);
    }
    for (const s of pp?.mustNotContain ?? []) {
      check(!ctx.personaPrelude.includes(s), `personaPrelude contains "${s}"`);
    }

    const mustIncludeQuestions = new Set(oq.mustInclude ?? []);

    const expectedRelevant = rb.shouldOnlyInclude
      ? new Set(rb.shouldOnlyInclude)
      : new Set(
          [...(rb.mustInclude ?? [])].filter((id) => !pinnedInSeed.has(id)),
        );

    const retrievalHits = [...expectedRelevant].filter((id) =>
      relevantIds.has(id),
    ).length;

    const retrievalPrecision =
      relevantIds.size === 0 && expectedRelevant.size === 0
        ? null
        : relevantIds.size === 0
          ? null
          : retrievalHits / relevantIds.size;

    const retrievalRecall =
      expectedRelevant.size === 0
        ? null
        : retrievalHits / expectedRelevant.size;

    const expectedPinnedFromFacts = new Set(pf.mustInclude ?? []);
    const pinnedHits = [...expectedPinnedFromFacts].filter((id) =>
      pinnedIds.has(id),
    ).length;
    const pinnedCoverage =
      expectedPinnedFromFacts.size === 0
        ? null
        : pinnedHits / expectedPinnedFromFacts.size;

    const questionHits = [...mustIncludeQuestions].filter((id) =>
      questionIds.has(id),
    ).length;
    const questionPrecision =
      questionIds.size === 0 || mustIncludeQuestions.size === 0
        ? null
        : questionHits / questionIds.size;
    const questionRecall =
      mustIncludeQuestions.size === 0
        ? null
        : questionHits / mustIncludeQuestions.size;

    report.push({
      caseId: tc.caseId,
      description: tc.description,
      expandedQuery: ctx.expandedQuery,
      pinnedBeliefs: [...pinnedIds],
      relevantBeliefs: [...relevantIds],
      retrievedQuestions: [...questionIds],
      searchScores: ctx.searchScores.map((s) => ({
        id: s.id,
        score: Math.round(s.score * 100) / 100,
        clauses: s.scoreDetails
          ? extractClauses(s.scoreDetails as ScoreNode, s.id)
          : [],
      })),
      retrievalPrecision,
      retrievalRecall,
      pinnedCoverage,
      questionPrecision,
      questionRecall,
      passed: failures.length === 0,
      failures,
    });

    if (failures.length > 0) t.fail(failures.join("\n"));
    else t.pass();
  });
}

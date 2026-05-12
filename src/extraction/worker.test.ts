import anyTest, { type TestFn } from "ava";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, type Db } from "mongodb";
import { randomUUID } from "node:crypto";
import sinon from "sinon";

import { ExtractionWorker } from "./worker.js";
import { BeliefMerger } from "./merger.js";
import type { ExtractionJob } from "../types/job.js";
import type { Belief, BeliefType } from "../types/belief.js";

const test = anyTest.serial as TestFn;

const USER_ID = "extraction-worker-user";
const SESSION_ID = "extraction-worker-session";

let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db("extraction-worker-test");
});

test.after.always(async () => {
  await client.close();
  await mongod.stop();
});

test.afterEach(async () => {
  sinon.restore();
  await Promise.all([
    db.collection<ExtractionJob>("jobs").deleteMany({}),
    db.collection("beliefs").deleteMany({}),
    db.collection("config").deleteMany({}),
    db.collection("style_signals").deleteMany({}),
  ]);
});

function makeWorker() {
  return new ExtractionWorker({
    db,
    beliefs: db.collection("beliefs"),
    personaSummary: { regenerate: sinon.stub().resolves() },
  });
}

function makeSidecar(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [],
    belief_updates: [],
    new_open_questions: [],
    ...overrides,
  });
}

function makeNewBelief(overrides: Record<string, unknown> = {}) {
  return {
    type: "preference",
    canonical_name: `belief-${randomUUID()}`,
    content: "Content worth persisting across sessions",
    why_it_matters: "Avoids re-explanation next session",
    scope: ["coding"],
    confidence: 0.8,
    aliases: [],
    epistemic_status: "active",
    ...overrides,
  };
}

function makeJob(overrides: Partial<ExtractionJob> = {}): ExtractionJob {
  return {
    _id: randomUUID(),
    type: "extract_beliefs" as const,
    status: "pending" as const,
    user_id: USER_ID,
    session_id: SESSION_ID,
    turn_id: randomUUID(),
    attempts: 0,
    max_attempts: 3,
    run_after: new Date(Date.now() - 1_000),
    created_at: new Date(),
    updated_at: new Date(),
    last_error: null,
    completed_at: null,
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed" as const,
      sidecar: makeSidecar(),
      source_model: "anthropic:claude-haiku",
    },
    ...overrides,
  };
}

function makeSeededBelief(canonicalName: string): Belief {
  const now = new Date();
  return {
    _id: randomUUID(),
    user_id: USER_ID,
    type: "preference" as BeliefType,
    canonical_name: canonicalName,
    aliases: [],
    content: "Content worth persisting across sessions",
    why_it_matters: "Avoids re-explanation next session",
    scope: ["coding"],
    provenance: {
      session_id: SESSION_ID,
      turn_id: "seed-turn",
      extracted_at: now,
      source_model: "test",
    },
    epistemic_status: "active",
    confidence: 0.8,
    reinforcement_count: 0,
    last_reinforced_at: now,
    pinned: false,
    user_edited: false,
    resolved_at: null,
    superseded_by: null,
    created_at: now,
    updated_at: now,
    change_log: [],
    subtype: null,
  };
}

test("sweep: returns 0 when no pending jobs exist", async (t) => {
  t.is(await makeWorker().sweep(), 0);
});

test("sweep: processes one pending job and returns 1", async (t) => {
  await db.collection<ExtractionJob>("jobs").insertOne(makeJob());
  t.is(await makeWorker().sweep(), 1);
});

test("sweep: respects limit — processes N jobs and leaves the rest pending", async (t) => {
  await db
    .collection<ExtractionJob>("jobs")
    .insertMany([makeJob(), makeJob(), makeJob()]);

  t.is(await makeWorker().sweep(2), 2);
  t.is(
    await db
      .collection<ExtractionJob>("jobs")
      .countDocuments({ status: "pending" }),
    1,
  );
});

test("sweep: skips jobs whose run_after is in the future", async (t) => {
  await db
    .collection<ExtractionJob>("jobs")
    .insertOne(makeJob({ run_after: new Date(Date.now() + 60_000) }));
  t.is(await makeWorker().sweep(), 0);
});

test("sweep: skips jobs that are not in pending status", async (t) => {
  await db
    .collection<ExtractionJob>("jobs")
    .insertMany([
      makeJob({ status: "running" }),
      makeJob({ status: "done" }),
      makeJob({ status: "failed" }),
    ]);
  t.is(await makeWorker().sweep(), 0);
});

test("processById: no-ops silently when job ID does not exist", async (t) => {
  await t.notThrowsAsync(() => makeWorker().processById(randomUUID()));
});

test("processById: no-ops when job is not pending", async (t) => {
  const job = makeJob({ status: "done" });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.is(doc!.attempts, 0);
});

test("processById: no-ops when run_after is in the future", async (t) => {
  const job = makeJob({ run_after: new Date(Date.now() + 60_000) });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "pending");
  t.is(doc!.attempts, 0);
});

test("processById: marks job done and sets completed_at on success", async (t) => {
  const job = makeJob();
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.truthy(doc!.completed_at);
});

test("processById: increments attempts on claim", async (t) => {
  const job = makeJob({ attempts: 0 });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.attempts, 1);
});

test("extract: completes with empty result_belief_ids when parse_status is missing", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "missing",
      source_model: "anthropic:claude",
      sidecar: "",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);
});

test("extract: completes with empty result_belief_ids when sidecar field is absent", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      source_model: "anthropic:claude",
      sidecar: null,
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);
});

test("extract: repairs sidecar with needs_repair status and inserts beliefs", async (t) => {
  const embedded = makeSidecar({ new_beliefs: [makeNewBelief()] });
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "needs_repair",
      sidecar: `malformed prefix ${embedded} trailing junk`,
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.is((doc!.result_belief_ids as string[]).length, 1);
});

test("extract: completes with empty result when needs_repair sidecar has no recoverable JSON", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "needs_repair",
      sidecar: "no curly brackets here at all",
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);
});

test("extract: inserts new beliefs and stores their IDs on the job", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({ new_beliefs: [makeNewBelief(), makeNewBelief()] }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.is((doc!.result_belief_ids as string[]).length, 2);
  t.is(await db.collection("beliefs").countDocuments({ user_id: USER_ID }), 2);
});

test("extract: result_belief_ids excludes reinforced beliefs — only INSERTED IDs returned", async (t) => {
  const canonicalName = `shared-${randomUUID()}`;
  await db
    .collection<Belief>("beliefs")
    .insertOne(makeSeededBelief(canonicalName));

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [makeNewBelief({ canonical_name: canonicalName })],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "done");
  t.deepEqual(doc!.result_belief_ids, []);
});

test("extractOnboarding: marks config completed even when sidecar is absent", async (t) => {
  const job = makeJob({
    type: "onboarding_extraction",
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      source_model: "anthropic:claude",
      sidecar: null,
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const config = await db
    .collection("config")
    .findOne({ key: "onboarding_status" });
  t.is(config!.value, "completed");
});

test("extractOnboarding: marks config completed when sidecar fails to parse", async (t) => {
  const job = makeJob({
    type: "onboarding_extraction",
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: "not valid json {{{",
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const config = await db
    .collection("config")
    .findOne({ key: "onboarding_status" });
  t.is(config!.value, "completed");
});

test("extractOnboarding: sets user_edited true on all inserted beliefs", async (t) => {
  const job = makeJob({
    type: "onboarding_extraction",
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({ new_beliefs: [makeNewBelief()] }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const belief = await db.collection("beliefs").findOne({ user_id: USER_ID });
  t.truthy(belief);
  t.true(belief!.user_edited as boolean);
});

test("extractOnboarding: dedupes contradictory beliefs — neither side of the conflict is inserted", async (t) => {
  const sharedName = `conflict-${randomUUID()}`;
  const job = makeJob({
    type: "onboarding_extraction",
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({ canonical_name: sharedName, content: "Version A" }),
          makeNewBelief({ canonical_name: sharedName, content: "Version B" }),
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  t.is(await db.collection("beliefs").countDocuments({ user_id: USER_ID }), 0);
  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.deepEqual(doc!.result_belief_ids, []);
});

test("handle: resets job to pending for retry when error occurs and attempts < max_attempts", async (t) => {
  sinon
    .stub(BeliefMerger.prototype, "merge")
    .rejects(new Error("transient DB error"));

  const job = makeJob({
    attempts: 0,
    max_attempts: 3,
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({ new_beliefs: [makeNewBelief()] }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "pending");
  t.true((doc!.last_error as string).includes("transient DB error"));
});

test("handle: marks job failed when attempts reach max_attempts", async (t) => {
  sinon
    .stub(BeliefMerger.prototype, "merge")
    .rejects(new Error("persistent failure"));

  const job = makeJob({
    attempts: 2,
    max_attempts: 3,
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({ new_beliefs: [makeNewBelief()] }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is(doc!.status, "failed");
  t.truthy(doc!.last_error);
});

test("extract: low-confidence signal reinforces an existing belief rather than being dropped", async (t) => {
  const canonicalName = `low-conf-${randomUUID()}`;
  await db
    .collection<Belief>("beliefs")
    .insertOne(makeSeededBelief(canonicalName));

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            confidence: 0.2,
          }),
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const belief = await db
    .collection("beliefs")
    .findOne({ canonical_name: canonicalName, user_id: USER_ID });
  t.is(belief!.reinforcement_count, 1);
  t.is(
    await db
      .collection("beliefs")
      .countDocuments({ user_id: USER_ID, superseded_by: null }),
    1,
  );
});

test("extract: low-confidence signal for a non-existent belief is still dropped", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            confidence: 0.2,
          }),
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  t.is(await db.collection("beliefs").countDocuments({ user_id: USER_ID }), 0);
});

test("extract: style signals are persisted to the style_signals collection", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: JSON.stringify({
        turn_signal: "substantive",
        new_beliefs: [],
        belief_updates: [],
        new_open_questions: [],
        style_signals: [
          {
            observation: "Uses terse, imperative phrasing",
            pattern_type: "communication_style",
            confidence: "medium",
            requires_confirmation: false,
            scope: ["global"],
          },
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const signal = await db.collection("style_signals").findOne({
    user_id: USER_ID,
    observation: "Uses terse, imperative phrasing",
  });
  t.truthy(signal);
  t.is(signal!.observation_count, 1);
});

test("extract: repeated style signals accumulate observation_count rather than overwriting", async (t) => {
  const sidecarWithSignal = JSON.stringify({
    turn_signal: "substantive",
    new_beliefs: [],
    belief_updates: [],
    new_open_questions: [],
    style_signals: [
      {
        observation: "Prefers bullet points over prose",
        pattern_type: "formatting",
        confidence: "low",
        requires_confirmation: true,
        scope: ["global"],
      },
    ],
  });

  const makeSignalJob = () =>
    makeJob({
      payload: {
        user_message: "Hello",
        assistant_message: "Hi",
        scope: ["global"],
        parse_status: "parsed",
        sidecar: sidecarWithSignal,
        source_model: "anthropic:claude",
      },
    });

  const worker = makeWorker();
  const jobA = makeSignalJob();
  const jobB = makeSignalJob();
  await db.collection<ExtractionJob>("jobs").insertMany([jobA, jobB]);

  await worker.processById(jobA._id as string);
  await worker.processById(jobB._id as string);

  const signal = await db.collection("style_signals").findOne({
    user_id: USER_ID,
    observation: "Prefers bullet points over prose",
  });
  t.truthy(signal);
  t.is(signal!.observation_count, 2);
  t.truthy(signal!.created_at);
});

test("extract: job with no style signals does not write to style_signals collection", async (t) => {
  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({ new_beliefs: [makeNewBelief()] }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  t.is(
    await db.collection("style_signals").countDocuments({ user_id: USER_ID }),
    0,
  );
});

function makeInferredBelief(
  canonicalName: string,
  reinforcementCount = 4,
): Belief {
  const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
  return {
    ...makeSeededBelief(canonicalName),
    epistemic_status: "inferred",
    confidence: 0.55,
    reinforcement_count: reinforcementCount,
    created_at: old,
    updated_at: old,
    last_reinforced_at: old,
  };
}

test("extract: inferred belief is promoted to active once reinforcement threshold and age floor are met", async (t) => {
  const canonicalName = `inferred-promote-${randomUUID()}`;
  await db
    .collection<Belief>("beliefs")
    .insertOne(makeInferredBelief(canonicalName, 4));

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            epistemic_status: "inferred",
          }),
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const belief = await db
    .collection("beliefs")
    .findOne({ canonical_name: canonicalName, user_id: USER_ID });
  t.is(belief!.epistemic_status, "active");
  t.true(
    belief!.change_log.some((e: { trigger: string }) =>
      e.trigger.includes("promoted from inferred"),
    ),
  );
});

test("extract: inferred belief is not promoted when reinforcement count is below threshold", async (t) => {
  const canonicalName = `inferred-no-promote-count-${randomUUID()}`;
  await db
    .collection<Belief>("beliefs")
    .insertOne(makeInferredBelief(canonicalName, 2));

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            epistemic_status: "inferred",
          }),
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const belief = await db
    .collection("beliefs")
    .findOne({ canonical_name: canonicalName, user_id: USER_ID });
  t.is(belief!.epistemic_status, "inferred");
});

test("extract: inferred belief is not promoted when age floor has not been reached", async (t) => {
  const canonicalName = `inferred-no-promote-age-${randomUUID()}`;
  const fresh = new Date(Date.now() - 60 * 60 * 1000);
  const belief = {
    ...makeSeededBelief(canonicalName),
    epistemic_status: "inferred",
    confidence: 0.55,
    reinforcement_count: 4,
    created_at: fresh,
    updated_at: fresh,
    last_reinforced_at: fresh,
  } as Belief;
  await db.collection<Belief>("beliefs").insertOne(belief);

  const job = makeJob({
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({
        new_beliefs: [
          makeNewBelief({
            canonical_name: canonicalName,
            epistemic_status: "inferred",
          }),
        ],
      }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const updated = await db
    .collection("beliefs")
    .findOne({ canonical_name: canonicalName, user_id: USER_ID });
  t.is(updated!.epistemic_status, "inferred");
});

test("handle: truncates last_error to 500 characters", async (t) => {
  sinon
    .stub(BeliefMerger.prototype, "merge")
    .rejects(new Error("x".repeat(600)));

  const job = makeJob({
    attempts: 2,
    max_attempts: 3,
    payload: {
      user_message: "Hello",
      assistant_message: "Hi",
      scope: ["global"],
      parse_status: "parsed",
      sidecar: makeSidecar({ new_beliefs: [makeNewBelief()] }),
      source_model: "anthropic:claude",
    },
  });
  await db.collection<ExtractionJob>("jobs").insertOne(job);

  await makeWorker().processById(job._id as string);

  const doc = await db
    .collection<ExtractionJob>("jobs")
    .findOne({ _id: job._id });
  t.is((doc!.last_error as string).length, 500);
});

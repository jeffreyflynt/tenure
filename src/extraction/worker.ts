import type { Collection, Db } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { ExtractionJob } from "../types/job.js";
import { BeliefWriter } from "./beliefWriter.js";
import { BeliefMerger, MergeAction } from "./merger.js";
import { safeParse, attemptRepair } from "./validator.js";
import {
  type ExtractionResult,
  type NewBelief,
  type StyleSignal,
} from "./types.js";

export interface ExtractionWorkerDeps {
  db: Db;
  beliefs: Collection<Belief>;
  personaSummary: { regenerate(userId: string): Promise<void> };
}

export interface ExtractionWorkerLike {
  sweep(limit?: number): Promise<number>;
  processById(jobId: string): Promise<void>;
}

export class ExtractionWorker implements ExtractionWorkerLike {
  private readonly jobs: Collection<ExtractionJob>;
  private readonly config: Collection;
  private readonly merger: BeliefMerger;
  private readonly writer: BeliefWriter;
  private readonly styleSignals: Collection;
  private readonly personaSummary: {
    regenerate(userId: string): Promise<void>;
  };

  constructor(deps: ExtractionWorkerDeps) {
    this.jobs = deps.db.collection<ExtractionJob>("jobs");
    this.config = deps.db.collection("config");
    this.styleSignals = deps.db.collection("style_signals");
    this.writer = new BeliefWriter(deps.beliefs);
    this.merger = new BeliefMerger(this.writer);
    this.personaSummary = deps.personaSummary;
  }

  async processById(jobId: string): Promise<void> {
    const job = await this.claim(jobId);
    if (!job) return;
    await this.handle(job);
  }

  async sweep(limit = 20): Promise<number> {
    let processed = 0;
    for (let i = 0; i < limit; i++) {
      const job = await this.claimNext();
      if (!job) break;
      await this.handle(job);
      processed++;
    }
    return processed;
  }

  private async claim(jobId: string): Promise<ExtractionJob | null> {
    const now = new Date();
    return this.jobs.findOneAndUpdate(
      { _id: jobId, status: "pending", run_after: { $lte: now } },
      {
        $set: { status: "running", claimed_at: now, updated_at: now },
        $inc: { attempts: 1 },
      },
      { returnDocument: "after" },
    ) as Promise<ExtractionJob | null>;
  }

  private async claimNext(): Promise<ExtractionJob | null> {
    const now = new Date();
    return this.jobs.findOneAndUpdate(
      { status: "pending", run_after: { $lte: now } },
      {
        $set: { status: "running", claimed_at: now, updated_at: now },
        $inc: { attempts: 1 },
      },
      { sort: { created_at: 1 }, returnDocument: "after" },
    ) as Promise<ExtractionJob | null>;
  }

  private async handle(job: ExtractionJob): Promise<void> {
    try {
      let beliefIds: string[] = [];

      if (job.type === "extract_beliefs") {
        beliefIds = await this.extract(job);
      } else if (job.type === "onboarding_extraction") {
        beliefIds = await this.extractOnboarding(job);
      } else if (job.type === "import_extraction") {
        beliefIds = await this.extractImport(job);
      }

      await this.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "done",
            completed_at: new Date(),
            updated_at: new Date(),
            result_belief_ids: beliefIds,
          },
        },
      );
    } catch (e) {
      const failed = job.attempts >= (job.max_attempts ?? 3);
      await this.jobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: failed ? "failed" : "pending",
            last_error: (e as Error).message.slice(0, 500),
            run_after: new Date(),
            updated_at: new Date(),
          },
        },
      );
    }
  }

  private async extract(job: ExtractionJob): Promise<string[]> {
    const payload = job.payload;
    const parseStatus = payload.parse_status ?? "missing";

    if (parseStatus === "missing") return [];

    let sidecarRaw = payload.sidecar;
    if (!sidecarRaw) return [];

    if (parseStatus === "needs_repair") {
      const repaired = attemptRepair(sidecarRaw);
      if (!repaired) return [];
      sidecarRaw = repaired;
    }

    const { result, error, skippedBeliefs } = safeParse(sidecarRaw);
    if (!result) {
      await this.jobs.updateOne(
        { _id: job._id },
        { $set: { "payload.validation_error": error } },
      );
      return [];
    }

    if (skippedBeliefs.length > 0) {
      await this.jobs.updateOne(
        { _id: job._id },
        { $set: { "payload.skipped_beliefs": skippedBeliefs } },
      );
    }

    return this.merge(job, result);
  }

  private async extractOnboarding(job: ExtractionJob): Promise<string[]> {
    const payload = job.payload;
    const sidecarRaw = payload.sidecar;

    if (!sidecarRaw) {
      await this.markOnboardingComplete();
      return [];
    }

    const { result } = safeParse(sidecarRaw);
    if (!result) {
      await this.markOnboardingComplete();
      return [];
    }

    const deduped = checkContradictions(result);
    const withUserEdited: ExtractionResult = {
      ...deduped,
      new_beliefs: deduped.new_beliefs.map((nb) => ({
        ...nb,
        user_edited: true,
      })),
    };

    const beliefIds = await this.merge(job, withUserEdited);
    await this.markOnboardingComplete();
    await this.personaSummary.regenerate(job.user_id);
    return beliefIds;
  }

  private async extractImport(job: ExtractionJob): Promise<string[]> {
    const sidecarRaw = job.payload.sidecar;
    if (!sidecarRaw) return [];

    const { result } = safeParse(sidecarRaw);
    if (!result) return [];

    const withUserEdited: ExtractionResult = {
      ...result,
      new_beliefs: result.new_beliefs.map((nb) => ({
        ...nb,
        user_edited: true,
      })),
    };

    const beliefIds = await this.merge(job, withUserEdited);
    await this.personaSummary.regenerate(job.user_id);
    return beliefIds;
  }

  private async merge(
    job: ExtractionJob,
    result: ExtractionResult,
  ): Promise<string[]> {
    const report = await this.merger.merge({
      userId: job.user_id,
      sessionId: job.session_id,
      turnId: job.turn_id ?? "",
      sourceModel: job.payload?.source_model ?? "unknown",
      result,
    });

    if (report.styleSignalsDeferred.length > 0) {
      await this.persistStyleSignals(
        job.user_id,
        job.session_id,
        report.styleSignalsDeferred,
      );
    }

    return report.decisions
      .filter((d) => d.action === MergeAction.INSERTED && d.beliefId)
      .map((d) => d.beliefId!);
  }

  /**
   * Upserts style signals into a dedicated collection using an increment
   * pattern. Each distinct signal surface is keyed by (user_id, signal) so
   * that repeated observations accumulate rather than overwrite. The
   * observation_count can later be used to graduate a style signal into a
   * proper belief once sufficient evidence has accumulated.
   */
  private async persistStyleSignals(
    userId: string,
    sessionId: string,
    signals: StyleSignal[],
  ): Promise<void> {
    const now = new Date();
    await Promise.all(
      signals.map((ss) =>
        this.styleSignals.updateOne(
          { user_id: userId, observation: ss.observation },
          {
            $inc: { observation_count: 1 },
            $set: {
              last_seen_at: now,
              last_session_id: sessionId,
              pattern_type: ss.pattern_type,
              confidence: ss.confidence,
              scope: ss.scope ?? [],
            },
            $setOnInsert: {
              user_id: userId,
              observation: ss.observation,
              created_at: now,
            },
          },
          { upsert: true },
        ),
      ),
    );
  }

  private async markOnboardingComplete(): Promise<void> {
    await this.config.updateOne(
      { key: "onboarding_status" },
      {
        $set: {
          key: "onboarding_status",
          value: "completed",
          encrypted: false,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
}

function checkContradictions(result: ExtractionResult): ExtractionResult {
  const seen = new Map<string, NewBelief>();
  const conflicts = new Set<string>();

  for (const nb of result.new_beliefs) {
    const key = nb.canonical_name.trim().toLowerCase();
    const existing = seen.get(key);
    if (existing && existing.content !== nb.content) {
      conflicts.add(key);
    } else {
      seen.set(key, nb);
    }
  }

  if (conflicts.size === 0) return result;

  return {
    ...result,
    new_beliefs: result.new_beliefs.filter(
      (nb) => !conflicts.has(nb.canonical_name.trim().toLowerCase()),
    ),
  };
}

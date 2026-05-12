import { randomUUID } from "node:crypto";
import type { Collection, Db } from "mongodb";
import type { ExtractionJob, ParseStatus } from "../types/job.js";

export interface EnqueueParams {
  userId: string;
  sessionId: string;
  turnId: string;
  userMessage: string;
  assistantMessage: string;
  sidecarRaw: string | null;
  parseStatus: ParseStatus;
  scope: string[];
  sourceModel: string;
}

export interface EnqueueOnboardingParams {
  userId: string;
  sessionId: string;
  sidecarRaw: string;
  sourceModel: string;
}

export interface EnqueueImportParams {
  userId: string;
  sourceLabel: string;
  sidecarJson: string;
  sourceModel: string;
  scope?: string[];
}

export class ExtractionJobQueue {
  private readonly col: Collection<ExtractionJob>;

  constructor(db: Db) {
    this.col = db.collection<ExtractionJob>("jobs");
  }

  async enqueue(params: EnqueueParams): Promise<string> {
    const now = new Date();
    const job: ExtractionJob = {
      _id: randomUUID(),
      type: "extract_beliefs",
      user_id: params.userId,
      session_id: params.sessionId,
      turn_id: params.turnId,
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      last_error: null,
      run_after: now,
      created_at: now,
      updated_at: now,
      completed_at: null,
      payload: {
        user_message: params.userMessage,
        assistant_message: params.assistantMessage,
        sidecar: params.sidecarRaw,
        parse_status: params.parseStatus,
        scope: params.scope,
        source_model: params.sourceModel,
      },
    };
    await this.col.insertOne(job);
    return job._id;
  }

  async enqueueOnboarding(params: EnqueueOnboardingParams): Promise<string> {
    const now = new Date();
    const job: ExtractionJob = {
      _id: randomUUID(),
      type: "onboarding_extraction",
      user_id: params.userId,
      session_id: params.sessionId,
      turn_id: "",
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      last_error: null,
      run_after: now,
      created_at: now,
      updated_at: now,
      completed_at: null,
      payload: {
        user_message: "",
        assistant_message: "",
        sidecar: params.sidecarRaw,
        parse_status: "parsed",
        scope: ["user:universal"],
        source_model: params.sourceModel,
      },
    };
    await this.col.insertOne(job);
    return job._id;
  }

  async enqueueImport(params: EnqueueImportParams): Promise<string> {
    const now = new Date();
    const job: ExtractionJob = {
      _id: randomUUID(),
      type: "import_extraction",
      user_id: params.userId,
      session_id: `import_${Date.now()}`,
      turn_id: "",
      status: "pending",
      attempts: 0,
      max_attempts: 3,
      last_error: null,
      run_after: now,
      created_at: now,
      updated_at: now,
      completed_at: null,
      payload: {
        user_message: "",
        assistant_message: "",
        sidecar: params.sidecarJson,
        parse_status: "parsed",
        scope: params.scope ?? ["user:universal"],
        source_model: params.sourceModel,
        source_label: params.sourceLabel,
      },
    };
    await this.col.insertOne(job);
    return job._id;
  }
}

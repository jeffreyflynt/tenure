import { randomUUID } from "node:crypto";
import type { Collections } from "../db/collections.js";
import type { ErrorLog, ErrorSeverity, ErrorStage } from "../types/error.js";

export interface ErrorInput {
  severity: ErrorSeverity;
  stage: ErrorStage;
  message: string;
  error?: Error;
  user_id: string;
  session_id?: string;
  turn_id?: string;
  provider?: string;
  model?: string;
  context?: Record<string, unknown>;
  user_impacted?: boolean;
  passthrough_succeeded?: boolean;
}

export class ErrorLogger {
  constructor(private readonly cols: Collections) {}

  async log(input: ErrorInput): Promise<void> {
    const doc: ErrorLog = {
      _id: randomUUID(),
      occurred_at: new Date(),
      severity: input.severity,
      stage: input.stage,
      message: input.message,
      exception_type: input.error?.name ?? null,
      stack_trace: input.error?.stack ?? null,
      user_id: input.user_id,
      session_id: input.session_id ?? null,
      turn_id: input.turn_id ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      context: input.context ?? {},
      user_impacted: input.user_impacted ?? false,
      passthrough_succeeded: input.passthrough_succeeded ?? null,
      resolved: false,
      resolved_at: null,
    };

    try {
      await this.cols.errors.insertOne(doc);
    } catch (e) {
      console.error("[error_logger] failed to persist error", {
        original: input,
        meta: e,
      });
    }
  }
}

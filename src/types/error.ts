export type ErrorSeverity = "warning" | "error" | "critical";

export type ErrorStage =
  | "session_resolution"
  | "context_assembly"
  | "topical_retrieval"
  | "provider_call"
  | "sidecar_parse"
  | "belief_extraction"
  | "belief_write"
  | "history_write"
  | "supersession"
  | "topic_index"
  | "config"
  | "job_enqueue"
  | "compaction";

export interface ErrorLog {
  _id: string;
  occurred_at: Date;
  severity: ErrorSeverity;
  stage: ErrorStage;
  message: string;
  exception_type: string | null;
  stack_trace: string | null;
  user_id: string;
  session_id: string | null;
  turn_id: string | null;
  provider: string | null;
  model: string | null;
  context: Record<string, unknown>;
  user_impacted: boolean;
  passthrough_succeeded: boolean | null;
  resolved: boolean;
  resolved_at: Date | null;
}

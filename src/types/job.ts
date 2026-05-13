export type JobStatus = "pending" | "running" | "done" | "failed";
export type ParseStatus = "parsed" | "needs_repair" | "missing";
export type JobType =
  | "extract_beliefs"
  | "onboarding_extraction"
  | "import_extraction";

export interface ExtractionJobPayload {
  user_message: string;
  assistant_message: string;
  sidecar: string | null;
  parse_status: ParseStatus;
  scope: string[];
  source_model: string;
  source_label?: string;
  client_category?: string;
}

export interface ExtractionJob {
  _id: string;
  type: JobType;
  user_id: string;
  session_id: string;
  turn_id: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: Date;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  payload: ExtractionJobPayload;
  result_belief_ids?: string[];
}

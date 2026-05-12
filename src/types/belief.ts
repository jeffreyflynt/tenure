export type BeliefType =
  | "entity"
  | "relation"
  | "preference"
  | "open_question"
  | "decision";

export type BeliefSubtype = "expertise" | "style" | null;

export type ExpertiseDepth = "learning" | "working" | "deep" | "expert";

export type EpistemicStatus =
  | "active"
  | "exploratory"
  | "superseded"
  | "inferred";

export interface Provenance {
  session_id: string;
  turn_id: string;
  extracted_at: Date;
  source_model: string;
}

export interface ChangeLogEntry {
  changed_at: Date;
  trigger: string;
  previous_content?: string | null;
  previous_epistemic_status?: EpistemicStatus | null;
  previous_confidence?: number | null;
  changed_by_session?: string | null;
  changed_by_turn?: string | null;
}

export interface Belief {
  _id: string;
  user_id: string;
  type: BeliefType;
  subtype: BeliefSubtype;
  canonical_name: string;
  aliases: string[];
  content: string;
  why_it_matters: string;
  scope: string[];
  provenance: Provenance;
  epistemic_status: EpistemicStatus;
  confidence: number;
  reinforcement_count: number;
  last_reinforced_at: Date;
  pinned: boolean;
  user_edited: boolean;
  superseded_by: string | null;
  resolved_at: Date | null;
  change_log: ChangeLogEntry[];
  compaction_note?: string;
  created_at: Date;
  updated_at: Date;
  expertise_domain?: string;
  expertise_depth?: ExpertiseDepth;
  expertise_evidence_count?: number;
}

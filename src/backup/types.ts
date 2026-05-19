export interface TenureExport {
  version: 1;
  exported_at: string;
  user_id: string;
  beliefs: ExportedBelief[];
  runtime_config: ExportedRuntimeConfig;
  persona_cache: ExportedPersonaDoc | null;
  compaction_log: ExportedCompactionEntry[];
  sessions: ExportedSession[];
}

export interface ExportedBelief {
  _id: string;
  type: string;
  subtype: string | null;
  canonical_name: string;
  aliases: string[];
  content: string;
  why_it_matters: string;
  scope: string[];
  provenance: {
    session_id: string;
    turn_id: string;
    extracted_at: string;
    source_model: string;
  };
  epistemic_status: string;
  confidence: number;
  reinforcement_count: number;
  last_reinforced_at: string;
  pinned: boolean;
  user_edited: boolean;
  superseded_by: string | null;
  resolved_at: string | null;
  change_log: Array<{
    changed_at: string;
    trigger: string;
    changed_by_session: string | null;
    changed_by_turn: string | null;
  }>;
  expertise_domain?: string;
  expertise_depth?: string;
  expertise_evidence_count?: number;
  compaction_note?: string;
  created_at: string;
  updated_at: string;
}

export interface ExportedRuntimeConfig {
  default_provider: string;
  default_model: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  openai_base_url: string | null;
  anthropic_base_url: string | null;
  openai_endpoint_flavor: string | null;
  always_on_token_target: number;
  managed_history_token_cap: number;
  error_retention_days: number;
  strict_model_tiers: boolean;
  extraction_enabled: boolean;
}

export interface ExportedPersonaDoc {
  universal: string;
  contributing_belief_ids: string[];
  beliefs_hash: string;
  generated_at: string;
  model: string;
}

export interface ExportedCompactionEntry {
  _id: string;
  user_id: string;
  scope: string;
  belief_type: string;
  ran_at: string;
  merged_count: number;
}

export interface ExportedSession {
  _id: string;
  userId: string;
  type: string;
  providerId: string | null;
  model: string | null;
  activeScope: string[];
  agentId?: string | null;
  turnCounter: number;
  createdAt: string;
  lastUsedAt: string;
}

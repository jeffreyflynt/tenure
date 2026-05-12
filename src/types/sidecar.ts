import type { BeliefType, EpistemicStatus } from "./belief.js";
import type { TurnSignal } from "./conversation.js";

export type StyleConfidence = "low" | "medium" | "high";
export type ExpertiseDepth = "learning" | "working" | "deep" | "expert";
export type BeliefSubtype = "expertise" | "style" | null;

export interface SidecarStyleSignal {
  observation: string;
  pattern_type: string;
  confidence: StyleConfidence;
  requires_confirmation?: boolean;
}

export interface SidecarBeliefCandidate {
  type: BeliefType;
  subtype: BeliefSubtype;
  canonical_name: string;
  aliases?: string[];
  content: string;
  why_it_matters: string;
  scope: string[];
  confidence: number;
  epistemic_status?: EpistemicStatus;
  expertise_domain?: string;
  expertise_depth?: ExpertiseDepth;
}

export interface SidecarPayload {
  turn_signal: TurnSignal;
  new_beliefs: SidecarBeliefCandidate[];
  belief_updates: Array<{
    belief_id: string;
    change: string;
    new_content?: string;
    new_canonical_name?: string;
  }>;
  entity_updates: Array<{ canonical_name: string; new_aliases: string[] }>;
  possible_alias_candidates: Array<{
    surface: string;
    possible_entities: string[];
    confidence: StyleConfidence;
  }>;
  resolved_open_questions: string[];
  new_open_questions: Array<{
    canonical_name: string;
    content: string;
    scope: string[];
  }>;
  style_signals?: SidecarStyleSignal[];
}

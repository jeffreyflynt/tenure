export type ChangeKind = "reinforced" | "contradicted" | "superseded";
export type TurnSignal =
  | "substantive"
  | "acknowledgment"
  | "clarification"
  | "correction";
export type StyleConfidence = "low" | "medium" | "high";
export type BeliefTypeStr =
  | "entity"
  | "relation"
  | "preference"
  | "open_question"
  | "decision";

export interface NewBelief {
  type: BeliefTypeStr;
  subtype?: "expertise" | "style" | null;
  canonical_name: string;
  content: string;
  scope: string[];
  confidence: number;
  why_it_matters: string;
  aliases: string[];
  epistemic_status: string;
  user_edited: boolean;
  resolves_open_question: string | null;
  expertise_domain?: string;
  expertise_depth?: "learning" | "working" | "deep" | "expert";
}

export interface BeliefUpdateSignal {
  belief_id: string;
  change: ChangeKind;
  new_content?: string | null;
  new_canonical_name?: string | null;
}

export interface EntityUpdate {
  canonical_name: string;
  new_aliases: string[];
}

export interface AliasCandidate {
  surface: string;
  possible_entities: string[];
  confidence: StyleConfidence;
}

export interface NewOpenQuestion {
  canonical_name: string;
  content: string;
  scope: string[];
}

export interface StyleSignal {
  observation: string;
  pattern_type: string;
  confidence: StyleConfidence;
  requires_confirmation: boolean;
  scope: string[];
}

export interface ExtractionResult {
  turn_signal: TurnSignal;
  new_beliefs: NewBelief[];
  belief_updates: BeliefUpdateSignal[];
  entity_updates: EntityUpdate[];
  possible_alias_candidates: AliasCandidate[];
  new_open_questions: NewOpenQuestion[];
  resolved_open_questions: string[];
  style_signals: StyleSignal[];
}

export function parseExtractionResult(
  raw: Record<string, unknown>,
): ExtractionResult {
  return {
    turn_signal: (raw.turn_signal as TurnSignal) ?? "substantive",
    new_beliefs: ((raw.new_beliefs as any[]) ?? []).map(parseNewBelief),
    belief_updates: ((raw.belief_updates as any[]) ?? []).map(
      parseBeliefUpdate,
    ),
    entity_updates: ((raw.entity_updates as any[]) ?? []).map(
      parseEntityUpdate,
    ),
    possible_alias_candidates: (
      (raw.possible_alias_candidates as any[]) ?? []
    ).map(parseAlias),
    new_open_questions: ((raw.new_open_questions as any[]) ?? []).map(
      parseOpenQuestion,
    ),
    resolved_open_questions: (raw.resolved_open_questions as string[]) ?? [],
    style_signals: ((raw.style_signals as any[]) ?? []).map(parseStyleSignal),
  };
}

function parseNewBelief(d: Record<string, unknown>): NewBelief {
  return {
    type: d.type as BeliefTypeStr,
    subtype: (d.subtype as "expertise" | "style" | null) ?? null,
    canonical_name: d.canonical_name as string,
    content: d.content as string,
    scope: (d.scope as string[]) ?? [],
    confidence: Number(d.confidence),
    why_it_matters: (d.why_it_matters as string) ?? "",
    aliases: (d.aliases as string[]) ?? [],
    epistemic_status: (d.epistemic_status as string) ?? "active",
    user_edited: false,
    resolves_open_question: (d.resolves_open_question as string) ?? null,
    ...(d.expertise_domain !== undefined && {
      expertise_domain: d.expertise_domain as string,
    }),
    ...(d.expertise_depth !== undefined && {
      expertise_depth: d.expertise_depth as
        | "learning"
        | "working"
        | "deep"
        | "expert",
    }),
  };
}

function parseBeliefUpdate(d: Record<string, unknown>): BeliefUpdateSignal {
  return {
    belief_id: d.belief_id as string,
    change: d.change as ChangeKind,
    new_content: (d.new_content as string) ?? null,
    new_canonical_name: (d.new_canonical_name as string) ?? null,
  };
}

function parseEntityUpdate(d: Record<string, unknown>): EntityUpdate {
  return {
    canonical_name: d.canonical_name as string,
    new_aliases: (d.new_aliases as string[]) ?? [],
  };
}

function parseAlias(d: Record<string, unknown>): AliasCandidate {
  return {
    surface: d.surface as string,
    possible_entities: (d.possible_entities as string[]) ?? [],
    confidence: d.confidence as StyleConfidence,
  };
}

function parseOpenQuestion(d: Record<string, unknown>): NewOpenQuestion {
  return {
    canonical_name: d.canonical_name as string,
    content: d.content as string,
    scope: (d.scope as string[]) ?? [],
  };
}

function parseStyleSignal(d: Record<string, unknown>): StyleSignal {
  return {
    observation: d.observation as string,
    pattern_type: d.pattern_type as string,
    confidence: d.confidence as StyleConfidence,
    requires_confirmation: Boolean(d.requires_confirmation),
    scope: (d.scope as string[]) ?? [],
  };
}

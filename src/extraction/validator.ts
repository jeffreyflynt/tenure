import type { ExtractionResult } from "./types.js";
import { parseExtractionResult } from "./types.js";

const FENCE_RE = /^```(?:json)?\s*|\s*```$/gi;

const VALID_TURN_SIGNALS = new Set([
  "substantive",
  "acknowledgment",
  "clarification",
  "correction",
]);
const VALID_BELIEF_TYPES = new Set([
  "entity",
  "relation",
  "preference",
  "open_question",
  "decision",
]);
const VALID_CHANGE_KINDS = new Set([
  "reinforced",
  "contradicted",
  "superseded",
]);

export interface ParseResult {
  result: ExtractionResult | null;
  error: string | null;
  skippedBeliefs: Array<{ index: number; error: string }>;
}

export function safeParse(llmOutput: string): ParseResult {
  try {
    const result = parseAndValidate(llmOutput);
    return {
      result,
      error: null,
      skippedBeliefs: result._skippedBeliefs ?? [],
    };
  } catch (e) {
    return { result: null, error: (e as Error).message, skippedBeliefs: [] };
  }
}

export function parseAndValidate(llmOutput: string): ExtractionResult & {
  _skippedBeliefs?: Array<{ index: number; error: string }>;
} {
  const cleaned = llmOutput.replace(FENCE_RE, "").trim();

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`invalid JSON: ${(e as Error).message}`);
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("expected a JSON object at top level");
  }

  const skippedBeliefs = validateSchema(data);

  try {
    const result = parseExtractionResult(data);
    (result as any)._skippedBeliefs = skippedBeliefs;
    return result as ExtractionResult & {
      _skippedBeliefs?: Array<{ index: number; error: string }>;
    };
  } catch (e) {
    throw new Error(`payload construction failed: ${(e as Error).message}`);
  }
}

function validateSchema(
  data: Record<string, unknown>,
): Array<{ index: number; error: string }> {
  const skipped: Array<{ index: number; error: string }> = [];

  if (
    data.turn_signal !== undefined &&
    !VALID_TURN_SIGNALS.has(data.turn_signal as string)
  ) {
    throw new Error(`invalid turn_signal: ${data.turn_signal}`);
  }

  if (data.new_beliefs !== undefined) {
    if (!Array.isArray(data.new_beliefs))
      throw new Error("new_beliefs must be an array");

    const valid: unknown[] = [];
    for (let i = 0; i < data.new_beliefs.length; i++) {
      try {
        validateNewBelief(data.new_beliefs[i]);
        valid.push(data.new_beliefs[i]);
      } catch (e) {
        skipped.push({ index: i, error: (e as Error).message });
      }
    }
    data.new_beliefs = valid;
  }

  if (data.belief_updates !== undefined) {
    if (!Array.isArray(data.belief_updates))
      throw new Error("belief_updates must be an array");
    for (const u of data.belief_updates) {
      if (!u || typeof u !== "object")
        throw new Error("belief_update must be an object");
      if (typeof (u as any).belief_id !== "string")
        throw new Error("belief_update.belief_id required");
      if (!VALID_CHANGE_KINDS.has((u as any).change))
        throw new Error(`invalid change kind: ${(u as any).change}`);
    }
  }

  if (data.entity_updates !== undefined) {
    if (!Array.isArray(data.entity_updates))
      throw new Error("entity_updates must be an array");
  }

  if (data.new_open_questions !== undefined) {
    if (!Array.isArray(data.new_open_questions))
      throw new Error("new_open_questions must be an array");
  }

  if (data.resolved_open_questions !== undefined) {
    if (!Array.isArray(data.resolved_open_questions))
      throw new Error("resolved_open_questions must be an array");
  }

  if (data.style_signals !== undefined) {
    if (!Array.isArray(data.style_signals))
      throw new Error("style_signals must be an array");
  }

  return skipped;
}

function validateNewBelief(b: unknown): void {
  if (!b || typeof b !== "object")
    throw new Error("new_belief must be an object");
  const belief = b as Record<string, unknown>;
  if (typeof belief.content !== "string" || !belief.content.trim()) {
    throw new Error("new_belief.content is required");
  }
  if (
    typeof belief.canonical_name !== "string" ||
    !belief.canonical_name.trim()
  ) {
    throw new Error("new_belief.canonical_name is required");
  }
  if (!VALID_BELIEF_TYPES.has(belief.type as string)) {
    throw new Error(`invalid belief type: ${belief.type}`);
  }
  if (
    typeof belief.confidence !== "number" ||
    belief.confidence < 0 ||
    belief.confidence > 1
  ) {
    throw new Error(`invalid confidence: ${belief.confidence}`);
  }
}

export function attemptRepair(raw: string): string | null {
  const clamped = raw.length > 32_000 ? raw.slice(0, 32_000) : raw;

  const match = clamped.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    JSON.parse(match[0]);
    return match[0];
  } catch {
    const greedy = clamped.match(/\{[\s\S]*\}/);
    if (!greedy) return null;
    try {
      JSON.parse(greedy[0]);
      return greedy[0];
    } catch {
      return null;
    }
  }
}

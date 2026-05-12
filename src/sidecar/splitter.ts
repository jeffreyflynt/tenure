export const SIDECAR_BEGIN = "<<<SIDECAR_JSON>>>";
export const SIDECAR_END = "<<<END_SIDECAR>>>";

export interface SplitResult {
  visible: string;
  sidecarRaw: string | null;
  parseStatus: "parsed" | "needs_repair" | "missing";
}

export function splitSidecar(content: string): SplitResult {
  const beginIdx = content.lastIndexOf(SIDECAR_BEGIN);
  if (beginIdx === -1)
    return {
      visible: content.trimEnd(),
      sidecarRaw: null,
      parseStatus: "missing",
    };

  const afterBegin = beginIdx + SIDECAR_BEGIN.length;
  const endIdx = content.indexOf(SIDECAR_END, afterBegin);
  const visible = content.slice(0, beginIdx).trimEnd();
  const sidecarRaw =
    endIdx === -1
      ? content.slice(afterBegin).trim()
      : content.slice(afterBegin, endIdx).trim();

  return {
    visible,
    sidecarRaw: sidecarRaw || null,
    parseStatus: endIdx === -1 || !sidecarRaw ? "needs_repair" : "parsed",
  };
}

export interface SidecarPayload {
  turn_signal?:
    | "substantive"
    | "acknowledgment"
    | "clarification"
    | "correction";
  topic_shift?: boolean;
  topic_label?: string;
  new_beliefs?: unknown[];
  belief_updates?: unknown[];
  entity_updates?: unknown[];
  possible_alias_candidates?: unknown[];
  resolved_open_questions?: unknown[];
  new_open_questions?: unknown[];
  style_signals?: unknown[];
  [key: string]: unknown;
}

export function parseSidecar(raw: string | null): SidecarPayload | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SidecarPayload;
  } catch {
    return null;
  }
}

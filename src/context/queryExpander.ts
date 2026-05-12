const MAX_QUERY_CHARS = 1000;
const MIN_RAW_CHARS = 16;

const STRIP_PATTERNS: RegExp[] = [
  /^```[\s\S]*?```/gm,
  /^~~~[\s\S]*?~~~/gm,
  /^(?: {4}|\t).+$/gm,
  /\[.+?\.(ts|js|py|json|toml|yaml|yml|md|txt|csv|pdf|png|jpg|jpeg|svg)\]/gi,
  /<.+?\.(ts|js|py|json|toml|yaml|yml|md|txt|csv|pdf|png|jpg|jpeg|svg)>/gi,
  /(?:^|\s)(?:\.{0,2}\/[\w/-]+\.(?:ts|js|py|json|toml|yaml|yml|md|txt|csv)|[\w-]+\/[\w/-]+\.(?:ts|js|py|json|toml|yaml|yml|md|txt|csv))\b/gi,
  /^\s+at\s+.+$/gm,
  /https?:\/\/[^\s]+/g,
  /`[^`]+`/g,
  /^#{1,6}\s+/gm,
  /\*{1,2}([^*]+)\*{1,2}/g,
  /_{1,2}([^_]+)_{1,2}/g,
  /<[^>]+>/g,
  /\b[0-9a-f]{8,}\b/gi,
  /\b\d+\b/g,
  /[?!.,;:]+(?=\s|$)/g,
];

function stripNoise(text: string): string {
  let out = text;
  for (const pattern of STRIP_PATTERNS) {
    out = out.replace(pattern, " ");
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

function clamp(text: string): string {
  return text.length > MAX_QUERY_CHARS ? text.slice(0, MAX_QUERY_CHARS) : text;
}

export interface ExpandedQuery {
  query: string;
  cleaned: string;
  wasNoisy: boolean;
}

/**
 * Build an Atlas Search query string from a raw user message.
 *
 * Pipeline:
 *   1. Strip code blocks, file refs, stack traces, URLs, markup
 *   2. Clamp to MAX_QUERY_CHARS (front-biased — intent is usually there)
 *   3. Return the cleaned text verbatim for Atlas Search
 *
 * Atlas Search's lucene.standard analyzer handles tokenization, lowercasing,
 * and IDF-weighted scoring. Stop words and filler terms score near-zero
 * naturally due to high document frequency — no NLP pre-filtering needed.
 * Fuzzy matching (maxEdits: 1) is applied by Atlas at query time across the
 * full token stream, so pre-extracting tokens with an NLP library only
 * removes signal and introduces noise.
 *
 * Returns an empty query string when the message is too short or entirely
 * noise — callers should skip the $search stage in that case.
 */
export function buildSearchQuery(userMessage: string): ExpandedQuery {
  const raw = userMessage.trim();

  if (raw.length < MIN_RAW_CHARS) {
    return { query: raw, cleaned: raw, wasNoisy: false };
  }

  const cleaned = stripNoise(raw);
  const wasNoisy = cleaned.length < raw.length * 0.5;

  if (!cleaned) {
    return { query: "", cleaned: "", wasNoisy: true };
  }

  const query = clamp(cleaned);
  return { query, cleaned, wasNoisy };
}

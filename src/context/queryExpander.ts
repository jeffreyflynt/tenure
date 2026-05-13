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

// Lines that are almost certainly code regardless of fencing
const CODE_LINE =
  /^\s*(const|let|var|function|class|import|export|default|return|async|await|if|else|for|while|switch|try|catch|def |class |from \w+ import|fn |impl |use std::|package |func |:=|\/\/|#!?[^\s]|\/\*|\*\/?\s)/;

const LANGUAGE_QUERY_TERMS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  ruby: "Ruby",
  swift: "Swift",
  kotlin: "Kotlin",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  shell: "shell",
  bash: "bash",
  sql: "SQL",
};

interface MessageSegment {
  type: "text" | "code";
  content: string;
}

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

/**
 * Split on explicit fenced code blocks first.
 * Returns segments typed as "text" or "code".
 */
function segmentMessage(raw: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const fenced = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = fenced.exec(raw)) !== null) {
    if (match.index > last) {
      segments.push({ type: "text", content: raw.slice(last, match.index) });
    }
    segments.push({ type: "code", content: match[0] });
    last = match.index + match[0].length;
  }

  if (last < raw.length) {
    segments.push({ type: "text", content: raw.slice(last) });
  }

  return segments;
}

/**
 * For messages with no fenced blocks, split by line heuristic.
 * Consecutive code-like lines are grouped as a single "code" segment.
 */
function splitUnfencedCode(text: string): MessageSegment[] {
  const lines = text.split("\n");
  const segments: MessageSegment[] = [];
  let buffer: string[] = [];
  let bufferType: "text" | "code" = "text";

  for (const line of lines) {
    const type = CODE_LINE.test(line) ? "code" : "text";
    if (type !== bufferType && buffer.length > 0) {
      segments.push({ type: bufferType, content: buffer.join("\n") });
      buffer = [];
    }
    bufferType = type;
    buffer.push(line);
  }

  if (buffer.length > 0) {
    segments.push({ type: bufferType, content: buffer.join("\n") });
  }

  return segments;
}

/**
 * Pull the language tag from a fenced block: ```typescript -> "typescript"
 */
function extractFencedLanguage(text: string): string | null {
  const match = text.match(/^```(\w+)/m);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Infer language from unfenced code content using lightweight syntax heuristics.
 */
function inferLanguage(code: string): string | null {
  if (/\b(fn |impl |use std::|let mut )/.test(code)) return "rust";
  if (/\b(func |package main|:= )/.test(code)) return "go";
  if (/^\s*(def |from \w+ import|if __name__)/m.test(code)) return "python";
  if (/:\s*(string|number|boolean|void)\b|interface \w+/.test(code))
    return "typescript";
  if (/\b(const|let|var|=>|async function)\b/.test(code)) return "javascript";
  if (/\b(public class|void main|System\.out)\b/.test(code)) return "java";
  if (/\b(func |var |let )\b.*\{/.test(code)) return "swift";
  return null;
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
 *   1. Segment the message into text and code portions
 *   2. Strip noise only from text segments
 *   3. If the natural language portion is too short to search on,
 *      fall back to the detected language as the query term
 *   4. Clamp to MAX_QUERY_CHARS and return
 *
 * Returns an empty query string when the message is too short or entirely
 * noise — callers should skip the $search stage in that case [3].
 */
export function buildSearchQuery(userMessage: string): ExpandedQuery {
  const raw = userMessage.trim();

  if (raw.length < MIN_RAW_CHARS) {
    return { query: raw, cleaned: raw, wasNoisy: false };
  }

  // Segment into text vs code portions
  const segments = segmentMessage(raw);
  const hasExplicitCode = segments.some((s) => s.type === "code");

  // For unfenced pastes, re-segment by line heuristic
  const working = hasExplicitCode ? segments : splitUnfencedCode(raw);

  const textOnly = working
    .filter((s) => s.type === "text")
    .map((s) => s.content)
    .join(" ")
    .trim();

  const cleaned = stripNoise(textOnly || raw);

  // Natural language portion is too thin to search on — try language fallback
  if (!cleaned || cleaned.length < MIN_RAW_CHARS) {
    const codeContent = working.find((s) => s.type === "code")?.content ?? raw;
    const lang =
      extractFencedLanguage(codeContent) ?? inferLanguage(codeContent);
    const langQuery = lang ? (LANGUAGE_QUERY_TERMS[lang] ?? null) : null;

    return {
      query: langQuery ?? "",
      cleaned: langQuery ?? "",
      wasNoisy: true,
    };
  }

  const wasNoisy = cleaned.length < raw.length * 0.5;
  return { query: clamp(cleaned), cleaned, wasNoisy };
}

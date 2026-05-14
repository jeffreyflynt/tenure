export function extractJsonBlock(raw: string): string | null {
  let s = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  s = normalizeQuotes(s);

  try {
    JSON.parse(s);
    return s;
  } catch {}

  const noTrailing = stripTrailingCommas(s);
  try {
    JSON.parse(noTrailing);
    return noTrailing;
  } catch {}

  const extracted = extractOutermostObject(s);
  if (extracted) {
    try {
      JSON.parse(extracted);
      return extracted;
    } catch {}

    const extractedNoTrailing = stripTrailingCommas(extracted);
    try {
      JSON.parse(extractedNoTrailing);
      return extractedNoTrailing;
    } catch {}
  }

  return null;
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,\s*([}\]])/g, "$1");
}

function normalizeQuotes(s: string): string {
  return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function extractOutermostObject(s: string): string | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (s[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

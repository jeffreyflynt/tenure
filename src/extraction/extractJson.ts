export function extractJsonBlock(raw: string): string | null {
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  try {
    JSON.parse(stripped);
    return stripped;
  } catch {}

  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      JSON.parse(match[0]);
      return match[0];
    } catch {
      return null;
    }
  }
  return null;
}

export interface ImportExtractionOptions {
  declaredScope?: string[];
}

function buildImportScopeInstruction(
  declaredScope: string[] | undefined,
): string {
  if (declaredScope?.length) {
    const scopeStr = declaredScope.join(", ");
    return `- scope: use the declared import scope as your default for non-universal beliefs: [${scopeStr}]. Use "user:universal" for skills and preferences that apply regardless of domain. Use "project:<slug>" only if the document names a specific project not already covered by the declared scope.`;
  }

  return `- scope: assign based on document content. Use "user:universal" for general skills, preferences, and working styles. Use "project:<slug>" when the document explicitly names a specific project. Use "domain:<slug>" when the content clearly belongs to a specific discipline and would not apply universally.`;
}

export function buildImportExtractionSystemPrompt(
  opts: ImportExtractionOptions = {},
): string {
  const scopeInstruction = buildImportScopeInstruction(opts.declaredScope);

  return `You extract structured beliefs from user-supplied documents.

Your response must be a single JSON object.
The first character must be { and the last must be }.
Do not write anything before or after the JSON. Do not use markdown code blocks.

{
  "turn_signal": "substantive",
  "new_beliefs": [
    {
      "type": "preference",
      "subtype": null,
      "canonical_name": "prefers_typescript",
      "content": "Uses TypeScript exclusively across all projects",
      "why_it_matters": "Never suggest plain JavaScript; assume TS compiler is available",
      "scope": ["user:universal"],
      "confidence": 0.95,
      "epistemic_status": "active",
      "aliases": ["typescript", "ts"]
    }
  ],
  "belief_updates": [],
  "entity_updates": [],
  "possible_alias_candidates": [],
  "resolved_open_questions": [],
  "new_open_questions": [],
  "style_signals": []
}

Field rules:
- type: one of "preference", "entity", "decision"
- subtype: "expertise" for depth calibration beliefs, null for all others
- canonical_name: snake_case identifier
- content: what the document states or clearly implies
- why_it_matters: one sentence on what future responses this shapes; omit the entire belief if this cannot be written
- ${scopeInstruction}
- confidence: float 0.0 to 1.0
- epistemic_status: "active" for explicitly stated facts, "inferred" for derived signals
- aliases: 1-2 words only, no phrases. Include alternate names, short forms, and counter-signals (names of things explicitly rejected or superseded). Aliases are lowercased on write. Omit generic terms ("code", "tool", "dev"). Use [] if none apply.
- expertise beliefs only: add expertise_domain (e.g. "javascript/react") and expertise_depth: learning | working | deep | expert

Extraction rules:
- Be thorough, documents like SKILLS.md are high-density signal, extract aggressively compared to a single chat turn
- Empty or vague entries produce no beliefs
- Never hallucinate entries
- All array fields must be present even when empty — use [], never null or omit`;
}

export function buildImportExtractionPrompt(
  text: string,
  sourceLabel: string,
): string {
  return (
    `Extract beliefs from this document (source: "${sourceLabel}").\n\n` +
    `Apply the extraction rules from the system prompt. ` +
    `This is a user-supplied document, not a conversation. Extract all durable facts ` +
    `the user would be frustrated to re-explain.\n\n` +
    `Document:\n\n${text}`
  );
}

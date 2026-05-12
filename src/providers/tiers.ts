export type ModelTier = 1 | 2;

export interface TierCheckResult {
  supported: boolean;
  tier: ModelTier | null;
  family: string | null;
  reason?: string;
}

export interface SupportedFamilySummary {
  family: string;
  tier: ModelTier;
  floor: string;
}

interface FamilyFloor {
  readonly family: string;
  readonly tier: ModelTier;
  readonly detect: RegExp;
  readonly extractVersion?: (id: string) => number | null;
  readonly minVersion?: number;
}

function extractClaudeVersion(modelId: string): number | null {
  const id = modelId.replace(/^(?:us\.|eu\.|ap\.)?anthropic\./i, "");

  const newStyle = id.match(
    /^claude-(?:opus|sonnet|haiku|claude)-(\d+)(?:-(\d+))?/i,
  );
  if (newStyle) {
    return parseInt(newStyle[1], 10) + parseInt(newStyle[2] ?? "0", 10) / 10;
  }

  const oldStyle = id.match(/^claude-(\d+)(?:-(\d+))?-/i);
  if (oldStyle) {
    return parseInt(oldStyle[1], 10) + parseInt(oldStyle[2] ?? "0", 10) / 10;
  }

  return null;
}

function extractGptVersion(modelId: string): number | null {
  if (/^gpt-4o-mini/i.test(modelId)) return 4.4;
  if (/^gpt-4o/i.test(modelId)) return 4.5;
  if (/^gpt-4-turbo/i.test(modelId)) return 4.1;
  if (/^gpt-4/i.test(modelId)) return 4.0;
  if (/^gpt-3/i.test(modelId)) return 3.0;
  return null;
}

export const TIER_FLOORS: readonly FamilyFloor[] = [
  {
    family: "claude",
    tier: 2,
    detect: /^claude-/i,
    extractVersion: extractClaudeVersion,
    minVersion: 4.5,
  },
  {
    family: "bedrock-claude",
    tier: 2,
    detect: /^(?:us\.|eu\.|ap\.)?anthropic\.claude/i,
    extractVersion: extractClaudeVersion,
    minVersion: 4.5,
  },
  {
    family: "bedrock-nova-pro",
    tier: 2,
    detect: /^(?:us\.|eu\.|ap\.)?amazon\.nova-pro/i,
  },
  {
    family: "gpt",
    tier: 2,
    detect: /^gpt-/i,
    extractVersion: extractGptVersion,
    minVersion: 4.4,
  },
  {
    family: "openai-o-series",
    tier: 1,
    detect: /^o[3-9]/i,
  },
] as const;

export function checkModelTier(modelId: string): TierCheckResult {
  const id = modelId.trim();

  for (const entry of TIER_FLOORS) {
    if (!entry.detect.test(id)) continue;

    if (entry.extractVersion !== undefined && entry.minVersion !== undefined) {
      const version = entry.extractVersion(id);
      if (version === null) {
        return {
          supported: false,
          tier: null,
          family: entry.family,
          reason:
            `Cannot determine version for "${modelId}" in family "${entry.family}". ` +
            `Minimum required: ${entry.minVersion}.`,
        };
      }
      if (version < entry.minVersion) {
        return {
          supported: false,
          tier: null,
          family: entry.family,
          reason:
            `"${modelId}" is version ${version} (family: ${entry.family}). ` +
            `Minimum supported version is ${entry.minVersion}.`,
        };
      }
    }

    return { supported: true, tier: entry.tier, family: entry.family };
  }

  return { supported: false, tier: null, family: null };
}

export function isModelSupported(modelId: string): boolean {
  return checkModelTier(modelId).supported;
}

export function listSupportedFamilies(): SupportedFamilySummary[] {
  return [
    {
      family: "claude",
      tier: 2,
      floor: "Claude 4.5 and above",
    },
    { family: "gpt", tier: 2, floor: "GPT-4o-mini and above" },
    { family: "openai-o-series", tier: 1, floor: "o3, o4-mini and above" },
    {
      family: "bedrock-claude",
      tier: 2,
      floor: "Bedrock: Anthropic Claude 4.5 and above",
    },
    { family: "bedrock-nova-pro", tier: 2, floor: "Bedrock: Amazon Nova Pro" },
  ];
}

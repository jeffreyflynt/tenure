import { createHash } from "node:crypto";
import type { Collection } from "mongodb";
import type { Belief } from "../types/belief.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { PersonaCache, PersonaDoc } from "./personaCache.js";

const UNIVERSAL_SCOPE = "user:universal";

export const PERSONA_PRELUDE_PROMPT = `You compose a compact persona prelude from structured beliefs about a user.
Output a single JSON object: { "universal": "string" }.

Rules:
- universal: 200-400 chars, one paragraph, second person ("You"). Prioritize in this order:
    1. Expertise — what can be assumed without explanation (from expertise_beliefs)
    2. Communication style — response length, tone, pushback preferences
    3. Working style — how they make decisions, when they want options vs. a recommendation
  Omit lower-signal details if the budget is tight. Do not mention project names or decisions.
- active beliefs are stated facts. inferred beliefs are tendencies — phrase them as patterns,
  not certainties ("tends to", "often prefers"). Omit exploratory beliefs entirely.
- If multiple beliefs describe the same preference with slight variation, synthesize into one
  characterization rather than repeating the same trait.
- Prohibitive beliefs (those describing what to avoid or never do) render as "Never do X".
- No meta-commentary. No preamble. Output only the JSON object.`;

export interface PersonaGeneratorDeps {
  beliefs: Collection<Belief>;
  cache: PersonaCache;
  adapter: () => ProviderAdapter;
  modelId: string;
}

export class PersonaSummaryService {
  constructor(private readonly deps: PersonaGeneratorDeps) {}

  async ensureFresh(
    userId: string,
  ): Promise<"fresh" | "regenerated" | "stale-served"> {
    const { universalBeliefs } = await this.loadContributing(userId);
    const hash = this.hash(universalBeliefs);
    const existing = await this.deps.cache.get(userId);

    if (existing?.beliefs_hash === hash) return "fresh";
    if (existing) {
      this.regenerate(userId, universalBeliefs, hash).catch(() => {});
      return "stale-served";
    }
    await this.regenerate(userId, universalBeliefs, hash);
    return "regenerated";
  }

  async regenerate(
    userId: string,
    universalBeliefs?: Belief[],
    hash?: string,
  ): Promise<void> {
    const loaded =
      universalBeliefs === undefined
        ? await this.loadContributing(userId)
        : { universalBeliefs };

    const digest = hash ?? this.hash(loaded.universalBeliefs);
    const universal = await this.callLLM(loaded.universalBeliefs);

    const existing = await this.deps.cache.get(userId);
    if (existing?.beliefs_hash === digest) return;

    const doc: PersonaDoc = {
      _id: userId,
      universal,
      contributing_belief_ids: loaded.universalBeliefs.map((b) => b._id),
      beliefs_hash: digest,
      generated_at: new Date(),
      model: this.deps.modelId,
    };
    await this.deps.cache.put(doc);
  }

  private async loadContributing(userId: string): Promise<{
    universalBeliefs: Belief[];
  }> {
    const all = await this.deps.beliefs
      .find({
        user_id: userId,
        type: "preference",
        resolved_at: null,
        superseded_by: null,
        epistemic_status: { $in: ["active", "inferred"] },
      })
      .sort({ last_reinforced_at: -1 })
      .limit(80)
      .toArray();

    const universalBeliefs = all.filter((b) =>
      b.scope.includes(UNIVERSAL_SCOPE),
    );

    return { universalBeliefs };
  }

  private hash(beliefs: Belief[]): string {
    const h = createHash("sha256");
    for (const b of [...beliefs].sort((a, z) => a._id.localeCompare(z._id))) {
      h.update(`${b._id}:${b.updated_at.toISOString()}\n`);
    }
    return h.digest("hex");
  }

  private async callLLM(universalBeliefs: Belief[]): Promise<string> {
    if (universalBeliefs.length === 0) return "";

    const expertiseBeliefs = universalBeliefs.filter(
      (b) => b.subtype === "expertise",
    );
    const preferenceBeliefs = universalBeliefs.filter(
      (b) => b.subtype !== "expertise",
    );

    const toPayload = (b: Belief) => ({
      canonical_name: b.canonical_name,
      content: b.content,
      why_it_matters: b.why_it_matters,
      epistemic_status: b.epistemic_status,
      ...(b.subtype === "expertise" && {
        expertise_domain: b.expertise_domain,
        expertise_depth: b.expertise_depth,
      }),
    });

    const payload = {
      expertise_beliefs: expertiseBeliefs.map(toPayload),
      preference_beliefs: preferenceBeliefs.map(toPayload),
    };

    const adapter = this.deps.adapter();
    const resp = await adapter.call(
      {
        model: this.deps.modelId,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
        temperature: 0.3,
        max_tokens: 1200,
      },
      PERSONA_PRELUDE_PROMPT,
    );

    const parsed = JSON.parse(this.extractJson(resp.content));
    return String(parsed.universal ?? "");
  }

  private extractJson(raw: string): string {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "");
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? match[0] : stripped;
  }
}

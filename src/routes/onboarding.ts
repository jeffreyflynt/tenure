import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ExtractionJobQueue } from "../jobs/queue.js";
import type { RuntimeConfigStore } from "../config/runtime.js";
import { checkModelTier } from "../providers/tiers.js";
import type { ExtractionWorkerLike } from "../extraction/worker.js";
import { extractJsonBlock } from "../extraction/extractJson.js";

export interface OnboardingDeps {
  providers: ProviderRegistry;
  jobs: ExtractionJobQueue;
  runtimeStore: RuntimeConfigStore;
  extractionWorker: ExtractionWorkerLike;
  personaSummary: {
    ensureFresh(
      userId: string,
    ): Promise<"fresh" | "regenerated" | "stale-served">;
  };
  userId: string;
}

export interface OnboardingQuestion {
  readonly id: string;
  readonly category: string;
  readonly text: string;
}

const SCOPE_BY_CATEGORY: Record<string, string[]> = {
  communication_style: ["user:universal"],
  working_style: ["user:universal"],
  output_preferences: ["user:universal"],
  expertise_calibration: ["user:universal"],
  project_seed: ["user:universal"],
};

export const ONBOARDING_QUESTIONS: readonly OnboardingQuestion[] = [
  {
    id: "response_length",
    category: "communication_style",
    text: "When you get a response that's longer than you expected, do you read it or skim it?",
  },
  {
    id: "ai_corrections",
    category: "communication_style",
    text: "Is there anything an AI does by default that you find yourself correcting often?",
  },
  {
    id: "expertise_deep",
    category: "expertise_calibration",
    text: "What topics do you work with deeply enough that you don't need things explained from first principles?",
  },
  {
    id: "expertise_learning",
    category: "expertise_calibration",
    text: "What are you actively learning where you'd benefit from more explanation?",
  },
  {
    id: "stuck_style",
    category: "working_style",
    text: "When you're stuck on something, do you want to think out loud with a thinking partner, or do you want someone to just tell you the answer?",
  },
  {
    id: "challenge_mode",
    category: "working_style",
    text: "When you tell the model what you want to do, should it just do it, or should it push back if it sees a problem with the plan?",
  },
  {
    id: "recommendation_style",
    category: "working_style",
    text: "Do you prefer to see options and decide, or get a single strong recommendation?",
  },
  {
    id: "ai_text_fixes",
    category: "output_preferences",
    text: "Is there anything about how AI-written text tends to sound that you find yourself fixing?",
  },
  {
    id: "authorship_mode",
    category: "output_preferences",
    text: "If you're writing something and the AI helps, who's the author — are you editing AI output, or is the AI editing your draft?",
  },
  {
    id: "current_project",
    category: "project_seed",
    text: 'What\'s the name or short label for your current project? (e.g. "Nexus API", "my dissertation", "the billing rewrite")',
  },
  {
    id: "immediate_context",
    category: "project_seed",
    text: "Is there anything about your current work someone would need to know to be useful to you immediately?",
  },
] as const;

const EXTRACTION_SYSTEM_PROMPT = `You extract structured beliefs from onboarding transcripts.

Your response must be a single JSON object.
The first character must be { and the last must be }.
Do not write anything before or after the JSON. Do not use markdown code blocks.

{
  "turn_signal": "substantive",
  "new_beliefs": [
    {
      "type": "preference",
      "canonical_name": "prefers_direct_answers",
      "content": "wants direct answers without lengthy preamble",
      "why_it_matters": "shapes response length and structure on every future turn",
      "scope": ["user:universal"],
      "confidence": 0.9,
      "epistemic_status": "active",
      "aliases": ["dislikes_preamble"]
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
- turn_signal: always "substantive" for onboarding extraction
- type: one of "preference", "entity", "decision"
- canonical_name: snake_case identifier, e.g. "prefers_concise_responses"
- content: what they said or clearly implied
- why_it_matters: one sentence on what future responses this shapes; omit the entire belief if this cannot be written
- scope: array of "kind:value" tags provided in the transcript metadata
- confidence: float 0.0 to 1.0
- epistemic_status: one of "active", "inferred" — use "inferred" for conclusions drawn beyond explicit statements
- aliases: alternative snake_case terms the user used for the same concept, or []

Extraction rules:
- Only capture what was actually said or clearly implied
- Empty or skipped answers produce no beliefs
- Never hallucinate entries`;

interface OnboardingAnswer {
  question_id: string;
  question: string;
  answer: string;
}

function slugifyProject(answer: string): string | null {
  const cleaned = answer
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 3)
    .join("-");
  return cleaned.length >= 3 ? cleaned : null;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "using",
  "build",
  "building",
  "working",
  "project",
  "app",
  "tool",
  "system",
  "some",
  "just",
]);

function deriveProjectScope(answers: OnboardingAnswer[]): string | null {
  const projectAnswer = answers.find(
    (a) => a.question_id === "current_project" && a.answer.trim(),
  );
  if (!projectAnswer) return null;
  const slug = slugifyProject(projectAnswer.answer);
  return slug ? `project:${slug}` : null;
}

function buildExtractionPrompt(
  answers: OnboardingAnswer[],
  projectScope: string | null,
): string {
  const questionIdToCategory = new Map(
    ONBOARDING_QUESTIONS.map((q) => [q.id, q.category]),
  );

  const transcript = answers
    .filter((a) => a.answer.trim().length > 0)
    .map((a) => {
      const category = questionIdToCategory.get(a.question_id) ?? "general";
      const base = SCOPE_BY_CATEGORY[category] ?? ["user:universal"];
      const scope =
        category === "project_seed" && projectScope
          ? [...base, projectScope]
          : base;
      return `[scope: ${JSON.stringify(scope)}]\nQ: ${a.question}\nA: ${a.answer}`;
    })
    .join("\n\n");

  return (
    `Read this onboarding transcript and extract beliefs that pass the ` +
    `runtime extraction gate:\n\n` +
    `- CONSEQUENTIAL: will shape future responses across sessions\n` +
    `- POSITIONAL: the user's own stance, preference, decision, or project state\n` +
    `- Not casual remarks, not general world knowledge, not ephemeral context\n\n` +
    `The why_it_matters field is the primary quality gate. If you cannot write ` +
    `a clear one-sentence explanation of what future responses this belief shapes, ` +
    `omit the belief entirely. The re-explanation test is a useful heuristic: ` +
    `would the user be frustrated to re-explain this next session?\n\n` +
    `Each answer is tagged with the scope its beliefs must use. Apply the scope ` +
    `tag from the preceding [scope: ...] line to every belief extracted from that answer.\n\n` +
    `Transcript:\n\n${transcript}`
  );
}

interface ParsedBelief {
  type: string;
  canonical_name: string;
  content: string;
  why_it_matters: string;
  scope: string[];
  confidence: number;
  epistemic_status?: string;
  aliases?: string[];
}

interface ParsedSidecar {
  new_beliefs: ParsedBelief[];
  [key: string]: unknown;
}

function validateSidecarShape(parsed: unknown): parsed is ParsedSidecar {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p.new_beliefs)) return false;
  for (const b of p.new_beliefs) {
    if (!b || typeof b !== "object") return false;
    const belief = b as Record<string, unknown>;
    if (typeof belief.content !== "string" || !belief.content.trim())
      return false;
    if (
      typeof belief.canonical_name !== "string" ||
      !belief.canonical_name.trim()
    )
      return false;
    if (
      typeof belief.why_it_matters !== "string" ||
      !belief.why_it_matters.trim()
    )
      return false;
  }
  return true;
}

interface DraftStore {
  set(draftId: string, data: { sidecarJson: string; modelId: string }): void;
  take(draftId: string): { sidecarJson: string; modelId: string } | null;
}

function createDraftStore(ttlMs = 10 * 60 * 1000): DraftStore {
  const drafts = new Map<
    string,
    { sidecarJson: string; modelId: string; expiry: number }
  >();
  return {
    set(draftId, data) {
      drafts.set(draftId, { ...data, expiry: Date.now() + ttlMs });
    },
    take(draftId) {
      const d = drafts.get(draftId);
      if (!d) return null;
      drafts.delete(draftId);
      if (Date.now() > d.expiry) return null;
      return { sidecarJson: d.sidecarJson, modelId: d.modelId };
    },
  };
}

export function registerOnboardingRoutes(
  app: FastifyInstance,
  deps: OnboardingDeps,
): void {
  const drafts = createDraftStore();

  app.get<{ Querystring: { token?: string } }>(
    "/onboarding",
    async (req, reply) => {
      reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(buildOnboardingHtml(req.query.token ?? ""));
    },
  );

  app.get("/v1/onboarding/questions", async () => ({
    questions: ONBOARDING_QUESTIONS,
    total: ONBOARDING_QUESTIONS.length,
  }));

  app.post("/v1/onboarding/skip", async () => ({ ok: true, skipped: true }));

  app.get<{ Params: { id: string } }>(
    "/v1/onboarding/probe-models/:id",
    async (req, reply) => {
      const { id } = req.params;
      let adapter;
      try {
        adapter = deps.providers.resolve(id);
      } catch {
        return reply.code(404).send({
          error: { message: `provider "${id}" not configured` },
        });
      }

      if (!adapter.listModels) {
        return reply.send({ models: [], supports_listing: false });
      }

      try {
        const models = await adapter.listModels();
        const annotated = models.map((m) => {
          const tier = checkModelTier(m.id);
          return {
            id: m.id,
            owned_by: m.owned_by,
            supported: tier.supported,
            family: tier.family,
            tier: tier.tier,
            reason: tier.supported ? null : (tier.reason ?? "unknown family"),
          };
        });
        return { models: annotated, supports_listing: true };
      } catch (err) {
        req.log.warn({ err, provider: id }, "listModels probe failed");
        return reply.code(502).send({
          error: {
            message: `failed to list models: ${(err as Error).message}`,
          },
        });
      }
    },
  );

  app.post<{ Body: { provider_id: string; model_id: string } }>(
    "/v1/onboarding/validate-model",
    async (req, reply) => {
      const { provider_id, model_id } = req.body ?? {};
      if (!provider_id || !model_id) {
        return reply.code(400).send({
          error: { message: "provider_id and model_id required" },
        });
      }

      const tier = checkModelTier(model_id);
      if (!tier.supported && tier.family !== null) {
        return reply.code(422).send({
          error: { message: tier.reason ?? "model below tier floor" },
          tier_check: tier,
        });
      }

      let adapter;
      try {
        adapter = deps.providers.resolve(provider_id);
      } catch {
        return reply.code(404).send({
          error: { message: `provider "${provider_id}" not configured` },
        });
      }

      try {
        await adapter.call(
          {
            model: model_id,
            messages: [{ role: "user", content: "ok" }],
            max_tokens: 1,
          },
          "",
        );
        await deps.runtimeStore.set("default_model", model_id);
        return { ok: true, tier_check: tier };
      } catch (err) {
        return reply.code(502).send({
          error: { message: `model ping failed: ${(err as Error).message}` },
          tier_check: tier,
        });
      }
    },
  );

  app.post<{ Body: { answers: OnboardingAnswer[] } }>(
    "/v1/onboarding/complete",
    async (req, reply) => {
      const { answers } = req.body ?? {};
      if (!Array.isArray(answers) || answers.length === 0) {
        return reply.code(400).send({ error: { message: "answers required" } });
      }

      const filled = answers.filter((a) => a.answer?.trim().length > 0);
      if (filled.length === 0) {
        return { ok: true, belief_count: 0, beliefs: [], draft_id: null };
      }

      const cfg = await deps.runtimeStore.load();

      const modelId = cfg.default_model;
      if (!modelId) {
        return reply.code(400).send({
          error: {
            message:
              "No default model configured. Complete provider setup first.",
          },
        });
      }

      const tierResult = checkModelTier(modelId);
      if (!tierResult.supported && tierResult.family !== null) {
        return reply.code(502).send({
          error: {
            message: `Onboarding model "${modelId}" does not meet the minimum tier. ${tierResult.reason}`,
          },
        });
      }
      if (!tierResult.supported) {
        req.log.warn(
          { modelId },
          "onboarding using unverified model family — sidecar quality not guaranteed",
        );
      }

      let adapter;
      try {
        adapter = deps.providers.detectFromModel(modelId, cfg.default_provider);
      } catch {
        return reply.code(502).send({
          error: {
            message: "no provider configured for onboarding extraction",
          },
        });
      }

      const projectScope = deriveProjectScope(filled);

      let extractionRaw: string;
      try {
        const resp = await adapter.call(
          {
            model: modelId,
            messages: [
              {
                role: "user",
                content: buildExtractionPrompt(filled, projectScope),
              },
            ],
            temperature: 0.1,
            max_tokens: 2000,
          },
          EXTRACTION_SYSTEM_PROMPT,
        );
        extractionRaw = resp.content;
      } catch (err) {
        req.log.error({ err }, "onboarding extraction LLM call failed");
        return reply
          .code(502)
          .send({ error: { message: "extraction LLM call failed" } });
      }

      const sidecarJson = extractJsonBlock(extractionRaw);
      if (!sidecarJson) {
        req.log.warn(
          { extractionRaw },
          "onboarding extraction output unparseable",
        );
        return {
          ok: true,
          belief_count: 0,
          beliefs: [],
          draft_id: null,
          parse_failed: true,
        };
      }

      const parsed = JSON.parse(sidecarJson) as ParsedSidecar;
      if (!validateSidecarShape(parsed)) {
        req.log.warn({ parsed }, "onboarding extraction schema invalid");
        return {
          ok: true,
          belief_count: 0,
          beliefs: [],
          draft_id: null,
          parse_failed: true,
        };
      }

      const draftId = randomUUID();
      drafts.set(draftId, { sidecarJson, modelId });

      return {
        ok: true,
        belief_count: parsed.new_beliefs.length,
        beliefs: parsed.new_beliefs,
        draft_id: draftId,
        project_scope: projectScope,
      };
    },
  );

  app.post<{ Body: { draft_id: string; edited_beliefs?: ParsedBelief[] } }>(
    "/v1/onboarding/commit",
    async (req, reply) => {
      const { draft_id, edited_beliefs } = req.body ?? {};
      if (!draft_id) {
        return reply
          .code(400)
          .send({ error: { message: "draft_id required" } });
      }

      const draft = drafts.take(draft_id);
      if (!draft) {
        return reply.code(404).send({
          error: { message: "draft not found or expired — re-run onboarding" },
        });
      }

      let finalSidecarJson = draft.sidecarJson;
      if (Array.isArray(edited_beliefs)) {
        const parsed = JSON.parse(draft.sidecarJson) as ParsedSidecar;
        parsed.new_beliefs = edited_beliefs;
        finalSidecarJson = JSON.stringify(parsed);
      }

      const jobId = await deps.jobs.enqueueOnboarding({
        userId: deps.userId,
        sessionId: `onboarding:${randomUUID()}`,
        sidecarRaw: finalSidecarJson,
        sourceModel: `onboarding:${draft.modelId}`,
      });

      deps.extractionWorker
        .processById(jobId)
        .then(() => deps.personaSummary.ensureFresh(deps.userId))
        .catch((err) =>
          req.log.warn(
            { err, jobId },
            "inline onboarding extraction failed — sweep will retry",
          ),
        );

      return { ok: true, job_id: jobId };
    },
  );
}

function buildOnboardingHtml(embeddedToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>Setup · Tenure</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root { --bg: #0f0f0f; --surface: #1a1a1a; --surface2: #222; --border: #2a2a2a; --text: #e8e8e8; --muted: #888; --accent: #015054; --danger: #ff6b6b; --ok: #6bffb8; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 2rem; }
  .card { width: 100%; max-width: 600px; }
  .header { margin-bottom: 2.5rem; }
  .header h1 { font-size: 1.25rem; font-weight: 500; margin-bottom: 0.5rem; }
  .header p { color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  .progress { display: flex; gap: 4px; margin-bottom: 2.5rem; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border); transition: background 0.2s; }
  .dot.done { background: var(--accent); }
  .dot.current { background: var(--text); }
  .question { font-size: 1.1rem; line-height: 1.6; margin-bottom: 1.5rem; }
  textarea { width: 100%; min-height: 120px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.95rem; line-height: 1.6; padding: 0.875rem 1rem; resize: vertical; outline: none; transition: border-color 0.15s; }
  textarea:focus { border-color: var(--accent); }
  .field { margin-bottom: 0.25rem; }
  .field label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 0.5rem; }
  .field input, .field select { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: inherit; font-size: 0.9rem; padding: 0.75rem 1rem; outline: none; margin-bottom: 1rem; appearance: none; -webkit-appearance: none; }
  .field input:focus, .field select:focus { border-color: var(--accent); }
  .field input[type=password] { font-family: monospace; }
  .field select { cursor: pointer; }
  .field select option { background: var(--surface); }
  .field .hint { font-size: 0.78rem; color: var(--muted); margin-top: -0.75rem; margin-bottom: 1rem; line-height: 1.4; opacity: 0.7; }
  .actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
  .btn { padding: 0.6rem 1.25rem; border-radius: 6px; font-size: 0.9rem; cursor: pointer; border: none; font-family: inherit; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: white; }
  .btn-ghost { background: transparent; color: var(--muted); padding: 0.6rem 0; }
  .btn-ghost:hover { color: var(--text); opacity: 1; }
  .spacer { flex: 1; }
  .error { color: var(--danger); font-size: 0.85rem; margin-bottom: 0.75rem; }
  .status { text-align: center; padding: 2rem 0; color: var(--muted); font-size: 0.9rem; }
  .status h2 { font-size: 1.25rem; color: var(--text); margin-bottom: 0.75rem; font-weight: 500; }
  .belief-preview { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 0.75rem 0.9rem; margin-bottom: 0.4rem; }
  .belief-preview .bname { font-size: 0.85rem; font-weight: 500; margin-bottom: 0.3rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .belief-preview .badge { font-size: 0.7rem; padding: 0.1rem 0.4rem; background: var(--surface2); border-radius: 3px; color: var(--muted); }
  .belief-preview .bcontent { font-size: 0.82rem; line-height: 1.5; margin-bottom: 0.3rem; }
  .belief-preview .bwhy { font-size: 0.75rem; color: var(--muted); font-style: italic; }
  .belief-preview input[type=checkbox] { accent-color: var(--accent); margin-right: 0.5rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .logo { display: block; margin: 0 auto 2rem; width: 120px; }
</style>
</head>
<body>
<div class="card" id="app"><div class="status"><p>Loading…</p></div></div>
<script>
const STORAGE_KEY = "mp_token";
const Q_URL = "/v1/onboarding/questions";
const COMPLETE_URL = "/v1/onboarding/complete";
const COMMIT_URL = "/v1/onboarding/commit";
const SKIP_URL = "/v1/onboarding/skip";

let token = ${embeddedToken ? JSON.stringify(embeddedToken) : 'new URLSearchParams(location.search).get("token") || localStorage.getItem(STORAGE_KEY) || ""'};
let questions = [];
let answers = [];
let idx = 0;
let draftBeliefs = [];
let draftId = null;
let beliefsKept = [];

const app = document.getElementById("app");
const set = h => { app.innerHTML = h; };

const FLAVORS = [
  {
    id: "generic",
    label: "Generic OpenAI",
    urlPlaceholder: "https://api.openai.com/v1",
    hint: "Standard OpenAI API or any compatible endpoint without special caching support.",
  },
  {
    id: "bedrock-access-gateway",
    label: "Bedrock Access Gateway",
    urlPlaceholder: "http://localhost:5757/api/v1",
    hint: "AWS Bedrock Access Gateway running locally or on your network. Enables Bedrock prompt caching, which cuts input costs by up to 90%.",
  },
  {
    id: "litellm",
    label: "LiteLLM",
    urlPlaceholder: "http://localhost:4000",
    hint: "LiteLLM proxy. If pointed at Bedrock, prompt caching hints will be translated automatically.",
  },
];

function flavorById(id) {
  return FLAVORS.find(f => f.id === id) ?? FLAVORS[0];
}

function showTokenScreen(err) {
  set(\`
  <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="header"><h1>Tenure</h1><p>Enter your API token to begin setup.</p></div>
    <div class="field">
      <label for="tok">API Token</label>
      <input id="tok" type="password" placeholder="your-token-here" autocomplete="off" />
    </div>
    \${err ? \`<div class="error">\${err}</div>\` : ""}
    <button class="btn btn-primary" style="width:100%" onclick="handleToken()">Continue</button>
  \`);
  const inp = document.getElementById("tok");
  inp?.focus();
  inp?.addEventListener("keydown", e => { if (e.key === "Enter") handleToken(); });
}

function handleToken() {
  const v = document.getElementById("tok")?.value?.trim();
  if (!v) return;
  token = v;
  localStorage.setItem(STORAGE_KEY, token);
  init();
}

function showProviderSetup(err) {
  set(\`
    <div class="header">
      <h1>Connect a provider</h1>
      <p>Tenure needs an LLM to run onboarding extraction and belief injection.</p>
    </div>
    <div class="field">
      <label for="prov-id">Provider</label>
      <select id="prov-id" onchange="onProviderChange(this.value)">
        <option value="openai">OpenAI (or compatible endpoint)</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </div>
    <div class="field">
      <label for="prov-key">API Key</label>
      <input id="prov-key" type="password" placeholder="sk-…" autocomplete="off" />
    </div>
    <div id="openai-extra">
      <div class="field">
        <label for="endpoint-flavor">Endpoint type</label>
        <select id="endpoint-flavor" onchange="onFlavorChange(this.value)">
          \${FLAVORS.map(f => \`<option value="\${f.id}">\${f.label}</option>\`).join("")}
        </select>
      </div>
      <div class="field">
        <label for="prov-url">Base URL <span style="opacity:0.5;font-size:0.8rem">(optional for generic OpenAI)</span></label>
        <input id="prov-url" type="text" placeholder="\${FLAVORS[0].urlPlaceholder}" />
        <div class="hint" id="flavor-hint">\${FLAVORS[0].hint}</div>
      </div>
    </div>
    \${err ? \`<div class="error">\${err}</div>\` : ""}
    <div class="actions">
      <div class="spacer"></div>
      <button class="btn btn-primary" id="save-provider" onclick="submitProvider()">Save and continue</button>
    </div>
  \`);
  document.getElementById("prov-key")?.focus();
}

function onProviderChange(provider) {
  const extra = document.getElementById("openai-extra");
  if (extra) extra.style.display = provider === "anthropic" ? "none" : "";
}

function onFlavorChange(flavorId) {
  const flavor = flavorById(flavorId);
  const urlInput = document.getElementById("prov-url");
  const hint = document.getElementById("flavor-hint");
  const urlLabel = urlInput?.previousElementSibling;

  if (urlInput) urlInput.placeholder = flavor.urlPlaceholder;
  if (hint) hint.textContent = flavor.hint;

  const optional = flavorId === "generic";
  if (urlLabel) {
    urlLabel.innerHTML = \`Base URL \${optional
      ? '<span style="opacity:0.5;font-size:0.8rem">(optional for generic OpenAI)</span>'
      : '<span style="color:var(--danger);font-size:0.8rem">*</span>'}\`;
  }
}

async function submitProvider() {
  const id      = document.getElementById("prov-id")?.value;
  const key     = document.getElementById("prov-key")?.value?.trim();
  const url     = document.getElementById("prov-url")?.value?.trim() || undefined;
  const flavor  = document.getElementById("endpoint-flavor")?.value || "generic";
  const btn     = document.getElementById("save-provider");

  if (!key) return showProviderSetup("API key is required.");

  if (id === "openai" && flavor !== "generic" && !url) {
    return showProviderSetup("A base URL is required for this endpoint type.");
  }

  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  try {
    const body = {
      api_key: key,
      ...(url ? { base_url: url } : {}),
      ...(id === "openai" ? { endpoint_flavor: flavor } : {}),
    };
    const res = await fetch(\`/admin/providers/\${id}\`, {
      method: "PUT",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return showProviderSetup(data?.error?.message ?? \`HTTP \${res.status}\`);
    }
    showModelPicker(id);
  } catch (e) {
    showProviderSetup(e.message);
  }
}

async function showModelPicker(providerId, err) {
  set(\`<div class="status"><p>Probing available models…</p></div>\`);
  try {
    const res = await fetch(\`/v1/onboarding/probe-models/\${providerId}\`, {
      headers: { Authorization: \`Bearer \${token}\` },
    });
    const data = await res.json();

    if (!res.ok) {
      return showProviderSetup(data?.error?.message ?? \`Probe failed (HTTP \${res.status})\`);
    }

    const models = data.models ?? [];
    const supported   = models.filter(m => m.supported);
    const unknown     = models.filter(m => !m.supported && m.family === null);
    const unsupported = models.filter(m => !m.supported && m.family !== null);

    if (supported.length === 0 && unknown.length === 0 && unsupported.length === 0) {
      return showProviderSetup("No models returned by this provider. Check credentials or base URL.");
    }

    set(\`
    <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
      <div class="header">
        <h1>Pick a default model</h1>
        <p>Used for belief extraction and as your chat default. You can change this later.</p>
      </div>
      <div class="field">
        <label for="model-select">Model</label>
        <select id="model-select">
          \${supported.length   ? \`<optgroup label="Supported">\${supported.map(m => \`<option value="\${m.id}">\${m.id}</option>\`).join("")}</optgroup>\` : ""}
          \${unknown.length     ? \`<optgroup label="Unknown family (use at your own risk)">\${unknown.map(m => \`<option value="\${m.id}">\${m.id}</option>\`).join("")}</optgroup>\` : ""}
          \${unsupported.length ? \`<optgroup label="Below tier floor (disabled)">\${unsupported.map(m => \`<option value="\${m.id}" disabled>\${m.id} — \${m.reason ?? ""}</option>\`).join("")}</optgroup>\` : ""}
        </select>
        <div class="hint">\${supported.length} supported, \${unknown.length} unknown, \${unsupported.length} below floor</div>
      </div>
      \${err ? \`<div class="error">\${err}</div>\` : ""}
      <div class="actions">
        <button class="btn btn-ghost" onclick="showProviderSetup()">Back</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="validate-btn" onclick="validateModel('\${providerId}')">Test and continue</button>
      </div>
    \`);
  } catch (e) {
    showProviderSetup(\`Probe error: \${e.message}\`);
  }
}

async function validateModel(providerId) {
  const modelId = document.getElementById("model-select")?.value;
  const btn = document.getElementById("validate-btn");
  if (!modelId) return;
  if (btn) { btn.disabled = true; btn.textContent = "Testing…"; }

  try {
    const res = await fetch("/v1/onboarding/validate-model", {
      method: "POST",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: providerId, model_id: modelId }),
    });
    const data = await res.json();
    if (!res.ok) {
      return showModelPicker(providerId, data?.error?.message ?? \`HTTP \${res.status}\`);
    }
    showQuestion();
  } catch (e) {
    showModelPicker(providerId, e.message);
  }
}

async function init() {
  try {
    const [qRes, cfgRes] = await Promise.all([
      fetch(Q_URL, { headers: { Authorization: \`Bearer \${token}\` } }),
      fetch("/admin/config", { headers: { Authorization: \`Bearer \${token}\` } }),
    ]);

    if (qRes.status === 401 || cfgRes.status === 401) {
      localStorage.removeItem(STORAGE_KEY);
      return showTokenScreen("Invalid token.");
    }
    if (!qRes.ok)   throw new Error(\`Failed to load questions (HTTP \${qRes.status})\`);
    if (!cfgRes.ok) throw new Error(\`Failed to load config (HTTP \${cfgRes.status})\`);

    const [qData, cfg] = await Promise.all([qRes.json(), cfgRes.json()]);

    questions = qData.questions;
    answers   = questions.map(q => ({ question_id: q.id, question: q.text, answer: "" }));
    idx = 0;

    const hasProvider = cfg.openai_configured || cfg.anthropic_configured;
    const hasModel    = cfg.default_model != null;

    if (!hasProvider) showProviderSetup();
    else if (!hasModel) showModelPicker(cfg.default_provider);
    else showQuestion();
  } catch (e) {
    set(\`<div class="status">
      <p style="color:var(--danger);margin-bottom:1rem">\${e.message}</p>
      <button class="btn btn-ghost" onclick="init()">Retry</button>
    </div>\`);
  }
}

function dots() {
  return questions.map((_, i) =>
    \`<div class="dot\${i < idx ? " done" : i === idx ? " current" : ""}"></div>\`
  ).join("");
}

function showQuestion() {
  const q = questions[idx];
  const isLast = idx === questions.length - 1;
  set(\`
  <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="header">
      <h1>Help us understand how you work</h1>
      <p>So we don't waste your time. All questions are optional — skip anything.</p>
    </div>
    <div class="progress">\${dots()}</div>
    <div class="question">\${q.text}</div>
    <textarea id="ans" placeholder="Type your answer…">\${answers[idx].answer}</textarea>
    <div class="actions">
      <button class="btn btn-ghost" onclick="skipAll()">Skip setup</button>
      \${idx > 0 ? \`<button class="btn btn-ghost" onclick="goBack()">← Back</button>\` : ""}
      <div class="spacer"></div>
      <button class="btn btn-ghost" onclick="advance(true)">Skip</button>
      <button class="btn btn-primary" onclick="advance(false)">\${isLast ? "Review" : "Next"}</button>
    </div>
  \`);
  const ans = document.getElementById("ans");
  ans?.focus();
  ans?.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) advance(false);
  });
}

function captureAnswer() {
  const v = document.getElementById("ans")?.value?.trim() ?? "";
  answers[idx].answer = v;
}

function goBack() {
  captureAnswer();
  if (idx > 0) { idx--; showQuestion(); }
}

function advance(skip) {
  if (!skip) captureAnswer();
  if (idx < questions.length - 1) { idx++; showQuestion(); }
  else submit();
}

async function skipAll() {
  try {
    await fetch(SKIP_URL, { method: "POST", headers: { Authorization: \`Bearer \${token}\` } });
  } catch {}
  set(\`
  <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="completion">
      <h2>Setup skipped</h2>
      <p>You can run onboarding at any time from the settings panel.</p>
      <p style="color:var(--muted);font-size:.85rem">
        Taking you to your beliefs dashboard in a moment...
      </p>
      <p style="font-size:.85rem;margin-top:.5rem">
        <a href="/beliefs">Go now</a>
      </p>
    </div>
  \`);
  setTimeout(() => { window.location.href = "/beliefs"; }, 2000);
}

async function submit() {
  set(\`
   <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <div class="status">
      <div style="display:flex;gap:6px;justify-content:center;margin-bottom:1.25rem">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--accent);
          animation:bounce 1.2s ease-in-out infinite;animation-delay:0s"></span>
        <span style="width:8px;height:8px;border-radius:50%;background:var(--accent);
          animation:bounce 1.2s ease-in-out infinite;animation-delay:0.2s"></span>
        <span style="width:8px;height:8px;border-radius:50%;background:var(--accent);
          animation:bounce 1.2s ease-in-out infinite;animation-delay:0.4s"></span>
      </div>
      <p id="wait-msg"></p>
    </div>
    <style>
      @keyframes bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
        40% { transform: translateY(-8px); opacity: 1; }
      }
    </style>
  \`);
  try {
    const res = await fetch(COMPLETE_URL, {
      method: "POST",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();

    if (data.parse_failed || data.belief_count === 0) {
      set(\`
        <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
        <div class="status">
          <h2>\${data.parse_failed ? "Extraction couldn't parse output" : "No beliefs extracted"}</h2>
          <p>Your answers were recorded but no beliefs were saved.</p>
          <p style="margin-top:0.75rem;font-size:0.85rem">
            <a href="/beliefs\${token ? '?token=' + encodeURIComponent(token) : ''}">Open world model →</a>
          </p>
        </div>
      \`);
      return;
    }

    draftBeliefs = data.beliefs ?? [];
    draftId = data.draft_id;
    beliefsKept = draftBeliefs.map(() => true);
    showReview(data.project_scope);
  } catch (e) {
    set(\`
      <div class="status">
        <h2>Something went wrong</h2>
        <p>\${e.message}</p>
        <button class="btn btn-ghost" style="margin-top:1rem" onclick="showQuestion()">Go back</button>
      </div>
    \`);
  }
}

function showReview(projectScope) {
  const preview = draftBeliefs.map((b, i) => \`
    <div class="belief-preview">
      <label class="bname">
        <input type="checkbox" data-idx="\${i}" \${beliefsKept[i] ? "checked" : ""} onchange="toggleBelief(\${i})">
        <span>\${esc(b.canonical_name)}</span>
        <span class="badge">\${esc(b.type)}</span>
        \${(b.scope ?? []).filter(s => s !== "user:universal").map(s => \`<span class="badge">\${esc(s)}</span>\`).join("")}
      </label>
      <div class="bcontent">\${esc(b.content)}</div>
      <div class="bwhy">\${esc(b.why_it_matters)}</div>
    </div>
  \`).join("");

  set(\`
    <div class="header">
      <h1>Review what we learned</h1>
      <p>Uncheck anything that's wrong or you don't want kept. You can edit further after setup.</p>
      \${projectScope ? \`<p style="margin-top:0.5rem;font-size:0.82rem">Project scope detected: <code style="background:var(--surface);padding:0.1rem 0.4rem;border-radius:3px">\${esc(projectScope)}</code></p>\` : ""}
    </div>
    <div>\${preview}</div>
    <div class="actions">
      <button class="btn btn-ghost" onclick="idx=questions.length-1;showQuestion()">← Back to questions</button>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="commit-btn" onclick="commitDraft()">Save to world model</button>
    </div>
  \`);
}

function toggleBelief(i) {
  const cb = document.querySelector(\`input[data-idx="\${i}"]\`);
  beliefsKept[i] = cb?.checked ?? false;
}

async function commitDraft() {
  const btn = document.getElementById("commit-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }

  const kept = draftBeliefs.filter((_, i) => beliefsKept[i]);
  try {
    const res = await fetch(COMMIT_URL, {
      method: "POST",
      headers: { Authorization: \`Bearer \${token}\`, "Content-Type": "application/json" },
      body: JSON.stringify({ draft_id: draftId, edited_beliefs: kept }),
    });
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const n = kept.length;
    set(\`
      <div class="status">
        <h2>You're all set</h2>
        <p>\${n} belief\${n === 1 ? "" : "s"} queued to your world model.</p>
        <div style="margin-top:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem 1.25rem;text-align:left">
          <div style="font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:.75rem">Point your client here</div>
          <div style="font-size:.85rem;margin-bottom:.5rem"><span style="color:var(--muted)">Base URL:</span> <code>http://localhost:5757/v1</code></div>
          <div style="font-size:.85rem"><span style="color:var(--muted)">API Key:</span> <code>\${esc(token)}</code>
          <div style="font-size:.72rem;color:var(--muted);margin-top:.4rem;opacity:.75">
            Your Tenure token is your API key — use the same value in both fields.
          </div>
          </div>
        </div>
        <div style="margin-top:1.25rem;display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;font-size:0.85rem">
          <a href="/beliefs\${token ? '?token=' + encodeURIComponent(token) : ''}">View world model →</a>
          <a href="/admin\${token ? '?token=' + encodeURIComponent(token) : ''}">Settings →</a>
        </div>
      </div>
    \`);
  } catch (e) {
    set(\`
      <div class="status">
        <h2>Couldn't save beliefs</h2>
        <p>\${e.message}</p>
        <button class="btn btn-ghost" style="margin-top:1rem" onclick="showReview()">Try again</button>
      </div>
    \`);
  }
}

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

token ? init() : showTokenScreen();
<\/script>
</body>
</html>`;
}

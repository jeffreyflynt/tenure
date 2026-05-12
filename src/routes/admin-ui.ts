import type { FastifyInstance } from "fastify";

export function registerAdminUiRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { token?: string } }>("/admin", async (req, reply) => {
    reply.header("content-type", "text/html; charset=utf-8");
    return reply.send(buildAdminHtml(req.query.token ?? ""));
  });
}

function buildAdminHtml(embeddedToken: string): string {
  const tokenJS = embeddedToken
    ? JSON.stringify(embeddedToken).replace(/</g, "\\u003c")
    : `new URLSearchParams(location.search).get("token") || localStorage.getItem("mp_token") || ""`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>Settings · Tenure</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f0f0f; --surface: #1a1a1a; --surface2: #222;
  --border: #2a2a2a; --text: #e8e8e8; --muted: #888;
  --accent: #015054; --danger: #ff6b6b; --ok: #6bffb8;
}
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; min-height: 100vh; }

.nav { display: flex; align-items: center; gap: 0; padding: 0 2rem; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 10; }
.nav-brand { font-size: .875rem; font-weight: 600; color: var(--text); text-decoration: none; margin-right: 1.5rem; padding: .875rem 0; white-space: nowrap; }
.nav-brand:hover { color: var(--accent); }
.nav-links { display: flex; align-items: stretch; gap: 0; }
.nav-link { font-size: .8rem; color: var(--muted); text-decoration: none; padding: .875rem .75rem; border-bottom: 2px solid transparent; transition: color .15s; white-space: nowrap; }
.nav-link:hover { color: var(--text); }
.nav-link.active { color: var(--text); border-bottom-color: var(--accent); }

.main { padding: 2rem; max-width: 680px; margin: 0 auto; }
.section { margin-bottom: 2.5rem; }
.section-title { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 1rem; }

.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem 1.375rem; margin-bottom: .5rem; }
.card-header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1rem; }
.card-title { font-size: .9rem; font-weight: 500; flex: 1; }
.card-status { font-size: .72rem; padding: .2rem .5rem; border-radius: 3px; font-weight: 600; }
.status-ok { background: #0d2a1a; color: var(--ok); }
.status-off { background: var(--surface2); color: var(--muted); }

.field { margin-bottom: .875rem; }
.field:last-child { margin-bottom: 0; }
.field label { display: block; font-size: .75rem; color: var(--muted); margin-bottom: .3rem; }
.field input, .field select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .85rem; padding: .55rem .75rem; outline: none; appearance: none; -webkit-appearance: none; }
.field input:focus, .field select:focus { border-color: var(--accent); }
.field input[type=password] { font-family: monospace; letter-spacing: .05em; }
.field input[type=number] { width: 140px; }
.field select { cursor: pointer; }
.field select option { background: var(--surface2); }
.field .hint { font-size: .75rem; color: var(--muted); margin-top: .3rem; line-height: 1.4; opacity: .75; }

.row { display: flex; align-items: center; gap: .75rem; flex-wrap: wrap; }
.row .field { flex: 1; min-width: 0; margin-bottom: 0; }

.btn { padding: .35rem .75rem; border-radius: 5px; font-size: .8rem; cursor: pointer; border: 1px solid var(--border); font-family: inherit; color: var(--muted); background: transparent; transition: all .15s; }
.btn:hover { color: var(--text); border-color: #444; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { opacity: .85; color: #fff; }
.btn-danger { color: var(--danger); border-color: transparent; }
.btn-danger:hover { border-color: var(--danger); }

.model-select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .85rem; padding: .55rem .75rem; outline: none; cursor: pointer; appearance: none; -webkit-appearance: none; }
.model-select:focus { border-color: var(--accent); }
.model-select option { background: var(--surface2); }

.advanced-toggle { display: flex; align-items: center; gap: .5rem; font-size: .78rem; color: var(--muted); cursor: pointer; background: none; border: none; font-family: inherit; padding: 0; margin-bottom: 1rem; }
.advanced-toggle:hover { color: var(--text); }
.advanced-content { display: none; }
.advanced-content.open { display: block; }

.screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
.screen-inner { width: 100%; max-width: 380px; }
.screen-inner h1 { font-size: 1.1rem; font-weight: 500; margin-bottom: .375rem; }
.screen-inner p { color: var(--muted); font-size: .875rem; margin-bottom: 1.5rem; line-height: 1.5; }
.screen-inner label { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .375rem; }
.screen-inner input { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: monospace; font-size: .9rem; padding: .75rem 1rem; outline: none; margin-bottom: .75rem; }
.screen-inner input:focus { border-color: var(--accent); }
.err-msg { color: var(--danger); font-size: .8rem; margin-bottom: .75rem; }
.loading { text-align: center; padding: 4rem 2rem; color: var(--muted); font-size: .875rem; }

.toast { position: fixed; bottom: 1.5rem; right: 1.5rem; padding: .6rem 1rem; border-radius: 6px; font-size: .8rem; z-index: 200; pointer-events: none; animation: slideup .2s ease; }
.toast-ok    { background: #0d2a1a; border: 1px solid var(--ok);     color: var(--ok); }
.toast-error { background: #2a1212; border: 1px solid var(--danger); color: var(--danger); }
@keyframes slideup { from { opacity: 0; transform: translateY(.4rem); } to { opacity: 1; transform: none; } }
.logo { display: block; margin: 0 auto 2rem; width: 120px; }
</style>
</head>
<body>
<div id="app"><div class="loading">Loading…</div></div>
<script>
const STORAGE_KEY = "mp_token";
let token = ${tokenJS};

const PROVIDERS = ["openai", "anthropic"];

let cfg = null;      
let providers = [];   
let models = {};      

const app = document.getElementById("app");

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
    hint: "AWS Bedrock Access Gateway. Enables Bedrock prompt caching, cutting input costs by up to 90%.",
  },
  {
    id: "litellm",
    label: "LiteLLM",
    urlPlaceholder: "http://localhost:4000",
    hint: "LiteLLM proxy. If pointed at Bedrock, prompt caching hints are translated automatically.",
  },
];

function flavorById(id) {
  return FLAVORS.find(f => f.id === id) ?? FLAVORS[0];
}

async function apiFetch(method, path, body) {
  const init = { method, headers: { Authorization: \`Bearer \${token}\` } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    localStorage.removeItem(STORAGE_KEY);
    showTokenScreen("Token rejected.");
    throw new Error("unauthorized");
  }
  return res;
}

async function init() {
  app.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const [cfgRes, provRes] = await Promise.all([
      apiFetch("GET", "/admin/config"),
      apiFetch("GET", "/admin/providers"),
    ]);
    if (!cfgRes.ok) throw new Error(\`Config load failed (HTTP \${cfgRes.status})\`);
    if (!provRes.ok) throw new Error(\`Providers load failed (HTTP \${provRes.status})\`);
    cfg = await cfgRes.json();
    providers = (await provRes.json()).providers ?? [];
    render();
    loadPersona()
    loadErrors();
  } catch (e) {
    if (e.message !== "unauthorized") {
      app.innerHTML = \`<div class="loading">
        <p style="color:var(--danger);margin-bottom:1rem">\${esc(e.message)}</p>
        <button class="btn" onclick="init()">Retry</button>
      </div>\`;
    }
  }
}

function navHtml() {
  return \`<nav class="nav">
    <a class="nav-brand" href="/beliefs">
      <img src="/assets/tenure-logo.png" alt="Tenure" height="24" style="vertical-align:middle">
    </a>
    <div class="nav-links">
      <a class="nav-link" href="/beliefs">World Model</a>
      <a class="nav-link active" href="/admin">Settings</a>
      <a class="nav-link" href="/onboarding">Onboarding</a>
    </div>
  </nav>\`;
}

function render() {
  const providerCards = providers.map(providerCard).join("");

  const defaultProvider = cfg.default_provider ?? "openai";
  const defaultModel = cfg.default_model ?? "";

  app.innerHTML = \`
    \${navHtml()}
    <div class="main">

      <div class="section">
        <div class="section-title">Providers</div>
        \${providerCards}
      </div>

      <div class="section">
        <div class="section-title">Default Model</div>
        <div class="card">
          <div class="field">
            <label>Model</label>
            <div class="row" style="align-items:flex-start">
              <div class="field" style="flex:1;margin:0">
                <select id="model-select" class="model-select" style="width:100%">
                  <option value="" disabled \${!defaultModel ? "selected" : ""}>— select a model —</option>
                  \${defaultModel ? \`<option value="\${esc(defaultModel)}" selected>\${esc(defaultModel)}</option>\` : ""}
                </select>
              </div>
              <button class="btn" onclick="loadModels()">Browse</button>
              <button class="btn btn-primary" onclick="saveModel()">Save</button>
            </div>
            <div class="hint">Used for belief extraction and onboarding. Must meet the minimum tier floor.</div>
          </div>
        </div>
      </div>

       <div class="section">
        <div class="section-title">Extraction</div>
        <div class="card">
      <div class="field">
        <label>Belief extraction</label>
        <div class="hint">When off, Tenure still injects your existing beliefs into every
        session but stops extracting new ones from conversations.</div>
        <div style="display:flex;align-items:center;gap:.75rem;margin-top:.625rem">
          <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
            <input type="checkbox" id="extraction-enabled"
              \${cfg.extraction_enabled !== false ? "checked" : ""}
              onchange="setExtractionEnabled(this.checked)"
              style="opacity:0;width:0;height:0;position:absolute">
            <span id="extraction-track" style="
              position:absolute;inset:0;border-radius:11px;transition:background .2s;
              background:\${cfg.extraction_enabled !== false ? 'var(--ok)' : 'var(--border)'};
            "></span>
            <span id="extraction-thumb" style="
              position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
              background:#fff;transition:transform .2s;
              transform:translateX(\${cfg.extraction_enabled !== false ? '21px' : '3px'});
            "></span>
          </label>
          <span id="extraction-label" style="font-size:.85rem;color:\${cfg.extraction_enabled !== false ? 'var(--ok)' : 'var(--muted)'}">
            \${cfg.extraction_enabled !== false ? "Enabled" : "Paused"}
          </span>
        </div>
      </div>
        </div>
        </div>

        <div class="section">
          <div class="section-title">Scope</div>
          <div class="card">
            <div class="field">
              <label>Automatic scope detection</label>
              <div class="hint">When enabled, Tenure detects the domain from your first message each session.
              When disabled, scope is only set via explicit <code>!scope</code> commands or client metadata.</div>
              <div style="display:flex;align-items:center;gap:.75rem;margin-top:.625rem">
                <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
                  <input type="checkbox" id="scope-auto-detect"
                    \${cfg.scope_auto_detect !== false ? "checked" : ""}
                    onchange="setScopeAutoDetect(this.checked)"
                    style="opacity:0;width:0;height:0;position:absolute">
                  <span id="scope-auto-track" style="
                    position:absolute;inset:0;border-radius:11px;transition:background .2s;
                    background:\${cfg.scope_auto_detect !== false ? "var(--ok)" : "var(--border)"};
                  "></span>
                  <span id="scope-auto-thumb" style="
                    position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
                    background:#fff;transition:transform .2s;
                    transform:translateX(\${cfg.scope_auto_detect !== false ? "21px" : "3px"});
                  "></span>
                </label>
                <span id="scope-auto-label" style="font-size:.85rem;color:\${cfg.scope_auto_detect !== false ? "var(--ok)" : "var(--muted)"}">
                 \${cfg.scope_auto_detect !== false ? "Auto-detect" : "Explicit only"}
                </span>
              </div>
            </div>
          </div>
        </div>

      <div class="section">
        <div class="section-title">Your Persona</div>
        <div class="card">
          <div class="field">
            <label>Standing context</label>
            <div class="hint">This is injected into every session as standing context about you.</div>
            <div id="persona-universal" style="margin-top:.5rem;font-size:.82rem;color:var(--text);line-height:1.5;min-height:2rem;background:var(--surface2);border-radius:5px;padding:.65rem .75rem;white-space:pre-wrap">Loading…</div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:.75rem">
            <button class="btn btn-primary" onclick="regeneratePersona()">Regenerate</button>
          </div>
        </div>
      </div>
       
      

      <div class="section">
        <button class="advanced-toggle" onclick="toggleAdvanced()">
          <span id="adv-arrow">▶</span> Advanced
        </button>
        <div class="advanced-content" id="adv-content">
          <div class="card">
            <div class="field">
              <label>Context budget (tokens)</label>
              <input id="cfg-token-target" type="number" min="100" max="2000" step="50"
                value="\${cfg.always_on_token_target ?? 400}">
              <div class="hint">How many tokens to reserve for injected beliefs per request. Lower values mean less context but faster responses. Default: 400.</div>
            </div>
            <div class="field">
              <label>Session history limit (tokens)</label>
              <input id="cfg-history-cap" type="number" min="10000" max="500000" step="10000"
                value="\${cfg.managed_history_token_cap ?? 120000}">
              <div class="hint">Maximum tokens of compacted session history to retain. Default: 120,000.</div>
            </div>
            <div class="field">
              <label>Verified models only</label>
              <div class="hint">When off, unverified model families are allowed. Disable if running a self-hosted model.</div>
              <div style="display:flex;align-items:center;gap:.75rem;margin-top:.5rem">
                <label style="position:relative;display:inline-block;width:40px;height:22px;cursor:pointer;flex-shrink:0">
                  <input type="checkbox" id="strict-model-tiers"
                    \${cfg.strict_model_tiers !== false ? "checked" : ""}
                    onchange="setStrictModelTiers(this.checked)"
                    style="opacity:0;width:0;height:0;position:absolute">
                  <span id="strict-tiers-track" style="
                    position:absolute;inset:0;border-radius:11px;transition:background .2s;
                    background:\${cfg.strict_model_tiers !== false ? 'var(--ok)' : 'var(--border)'};
                  "></span>
                  <span id="strict-tiers-thumb" style="
                    position:absolute;top:3px;width:16px;height:16px;border-radius:50%;
                    background:#fff;transition:transform .2s;
                    transform:translateX(\${cfg.strict_model_tiers !== false ? '21px' : '3px'});
                  "></span>
                </label>
                <span id="strict-tiers-label" style="font-size:.85rem;color:\${cfg.strict_model_tiers !== false ? 'var(--ok)' : 'var(--muted)'}">
                  \${cfg.strict_model_tiers !== false ? "Enforced" : "Off"}
                </span>
              </div>
            </div>
            <div class="field" style="margin-top:1rem">
              <label>History compaction mode</label>
              <select id="cfg-compaction-mode" class="input-sm" style="width:100%">
                <option value="aggressive"\${(cfg.compaction_mode ?? "aggressive") === "aggressive" ? " selected" : ""}>Aggressive — collapse acknowledgments, deduped turns, and completed topics</option>
                <option value="conservative"\${cfg.compaction_mode === "conservative" ? " selected" : ""}>Conservative — only collapse pure acknowledgments</option>
                <option value="off"\${cfg.compaction_mode === "off" ? " selected" : ""}>Off — keep all history (uses more tokens)</option>
              </select>
              <div class="hint">Controls how aggressively past turns are collapsed from session history. Aggressive is recommended for most users.</div>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:1rem">
              <button class="btn btn-primary" onclick="saveAdvanced()">Save</button>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">API Token</div>
        <div class="card">
          <div class="field">
            <label>Token rotation</label>
            <div class="hint">Generates a new token immediately. Your current session will end — copy the new token before closing this dialog.</div>
          </div>
          <div style="display:flex;justify-content:flex-end">
            <button class="btn btn-danger" onclick="rotateToken()">Rotate token…</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Maintenance</div>
        <div class="card">
          <div class="field">
            <label>Belief compaction</label>
            <div class="hint">Merges overlapping and redundant beliefs. Runs automatically 
            every 30 minutes — trigger manually after a large import or onboarding run.</div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-top:.75rem">
            <button class="btn btn-primary" id="compact-btn" onclick="runCompaction()">
              Merge redundant beliefs
            </button>
          </div>
          <div id="compact-status" style="margin-top:.75rem;font-size:.82rem"></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Error Log</div>
        <div class="card">
          <div class="field">
            <label>Recent errors</label>
            <div class="hint">If you're experiencing issues, copy these when filing a bug report.</div>
          </div>
          <div id="error-log" style="margin-top:.75rem;font-size:.8rem;color:var(--muted)">Loading...</div>
          <div style="display:flex;justify-content:flex-end;margin-top:.75rem;gap:.5rem">
            <button class="btn" onclick="copyErrors()">Copy to clipboard</button>
            <button class="btn" onclick="loadErrors()">Refresh</button>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Backup & Restore</div>
        <div class="card">
          <div class="field">
            <label>Export</label>
            <div class="hint">Download an encrypted archive of your entire world model.</div>
          </div>
          <div id="backup-preview" style="margin-top:.75rem;font-size:.8rem;color:var(--muted);display:none">
            <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-bottom:.75rem">
              <span id="bp-beliefs"></span>
              <span id="bp-sessions"></span>
              <span id="bp-persona"></span>
            </div>
          </div>
          <div class="row" style="margin-top:.75rem">
            <div class="field" style="flex:1;margin:0">
              <input id="export-passphrase" type="password" placeholder="Passphrase (min 8 characters)" autocomplete="off">
            </div>
            <button class="btn" onclick="loadBackupPreview()">Preview</button>
            <button class="btn btn-primary" onclick="exportBackup()">Export</button>
          </div>
        </div>
        <div class="card" style="margin-top:.5rem">
          <div class="field">
            <label>Import</label>
            <div class="hint">Restore from a previously exported archive. Existing beliefs with the same ID are skipped by default.</div>
          </div>
          <div class="field" style="margin-top:.75rem">
            <input id="import-file" type="file" accept=".enc" style="font-size:.8rem">
          </div>
          <div class="row" style="margin-top:.5rem">
            <div class="field" style="flex:1;margin:0">
              <input id="import-passphrase" type="password" placeholder="Passphrase" autocomplete="off">
            </div>
            <button class="btn btn-primary" onclick="importBackup()">Import</button>
          </div>
          <div style="display:flex;gap:.75rem;margin-top:.75rem">
            <label style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:.35rem">
              <input type="checkbox" id="import-skip-existing" checked> Skip existing beliefs
            </label>
            <label style="font-size:.75rem;color:var(--muted);display:flex;align-items:center;gap:.35rem">
              <input type="checkbox" id="import-config" checked> Restore settings
            </label>
          </div>
          <div id="import-result" style="margin-top:.75rem;font-size:.8rem;color:var(--ok);display:none"></div>
        </div>
      </div>

    </div>
  \`;

  const sel = document.getElementById("model-select");
  if (sel && models[defaultProvider]?.length) populateModelSelect(defaultProvider);
}

function providerCard(p) {
  const configured = p.configured;
  const isOpenAI = p.id === "openai";
  const currentFlavor = p.endpoint_flavor ?? "generic";
  const flavor = flavorById(currentFlavor);

  return \`
    <div class="card" id="card-\${esc(p.id)}">
      <div class="card-header">
        <span class="card-title">\${esc(providerLabel(p))}</span>
        <span class="card-status \${configured ? "status-ok" : "status-off"}">\${configured ? "Connected" : "Not connected"}</span>
      </div>
      <div class="field">
        <label>API Key</label>
        <input id="key-\${esc(p.id)}" type="password"
          placeholder="\${configured ? "••••••••  (set — enter new key to replace)" : "Paste API key…"}"
          autocomplete="off">
      </div>
      \${isOpenAI ? \`
      <div class="field">
        <label>Endpoint type</label>
        <select id="flavor-\${esc(p.id)}" onchange="onAdminFlavorChange('\${esc(p.id)}', this.value)">
          \${FLAVORS.map(f => \`<option value="\${f.id}" \${f.id === currentFlavor ? "selected" : ""}>\${f.label}</option>\`).join("")}
        </select>
      </div>
      <div class="field">
        <label id="url-label-\${esc(p.id)}">Base URL\${currentFlavor !== "generic" ? ' <span style="color:var(--danger);font-size:.75rem">*</span>' : ' <span style="opacity:.5;font-size:.75rem">(optional)</span>'}</label>
        <input id="url-\${esc(p.id)}" type="text"
          placeholder="\${esc(flavor.urlPlaceholder)}"
          value="\${esc(p.base_url ?? "")}">
        <div class="hint" id="flavor-hint-\${esc(p.id)}">\${esc(flavor.hint)}</div>
      </div>\` : ""}
      <div class="row" style="justify-content:flex-end;margin-top:.25rem">
        \${configured ? \`<button class="btn btn-danger" onclick="removeProvider('\${esc(p.id)}')">Disconnect</button>\` : ""}
        <button class="btn btn-primary" onclick="saveProvider('\${esc(p.id)}')">Save</button>
      </div>
    </div>
  \`;
}

function onAdminFlavorChange(providerId, flavorId) {
  const flavor = flavorById(flavorId);
  const urlInput = document.getElementById(\`url-\${providerId}\`);
  const urlLabel = document.getElementById(\`url-label-\${providerId}\`);
  const hint = document.getElementById(\`flavor-hint-\${providerId}\`);

  if (urlInput) urlInput.placeholder = flavor.urlPlaceholder;
  if (hint) hint.textContent = flavor.hint;
  if (urlLabel) {
    const optional = flavorId === "generic";
    urlLabel.innerHTML = \`Base URL\${optional
      ? ' <span style="opacity:.5;font-size:.75rem">(optional)</span>'
      : ' <span style="color:var(--danger);font-size:.75rem">*</span>'}\`;
  }
}

function providerLabel(p) {
  if (p.id === "anthropic") return "Anthropic";
  if (p.id === "openai") {
    const flavor = flavorById(p.endpoint_flavor ?? "generic");
    return flavor.id === "generic" ? "OpenAI (or compatible endpoint)" : flavor.label;
  }
  return p.id;
}

async function loadModels() {
  const provider = cfg.default_provider ?? "openai";
  const p = providers.find(x => x.id === provider);
  if (!p?.configured) {
    toast(\`No \${provider} credentials configured\`, "error");
    return;
  }

  const sel = document.getElementById("model-select");
  if (sel) { sel.innerHTML = '<option disabled selected>Loading…</option>'; }

  try {
    const res = await apiFetch("GET", \`/v1/onboarding/probe-models/\${provider}\`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    models[provider] = data.models ?? [];
    populateModelSelect(provider);
  } catch (e) {
    toast(e.message, "error");
    if (sel) sel.innerHTML = \`<option value="\${esc(cfg.default_model ?? "")}" selected>\${esc(cfg.default_model ?? "— select a model —")}</option>\`;
  }
}

function populateModelSelect(provider) {
  const sel = document.getElementById("model-select");
  if (!sel) return;
  const list = models[provider] ?? [];
  const supported   = list.filter(m => m.supported);
  const unknown     = list.filter(m => !m.supported && m.family === null);
  const unsupported = list.filter(m => !m.supported && m.family !== null);
  const current = cfg.default_model ?? "";
  const opt = (m, disabled) =>
    \`<option value="\${esc(m.id)}"\${m.id === current ? " selected" : ""}\${disabled ? " disabled" : ""}>\${esc(m.id)}\${disabled ? \` — \${esc(m.reason ?? "below floor")}\` : ""}</option>\`;
  sel.innerHTML = \`
    <option value="" disabled \${!current ? "selected" : ""}>— select a model —</option>
    \${supported.length   ? \`<optgroup label="Supported">\${supported.map(m => opt(m, false)).join("")}</optgroup>\` : ""}
    \${unknown.length     ? \`<optgroup label="Unknown family (use at your own risk)">\${unknown.map(m => opt(m, false)).join("")}</optgroup>\` : ""}
    \${unsupported.length ? \`<optgroup label="Below tier floor (disabled)">\${unsupported.map(m => opt(m, true)).join("")}</optgroup>\` : ""}
  \`;
}

async function saveModel() {
  const sel = document.getElementById("model-select");
  const modelId = sel?.value;
  if (!modelId) { toast("Select a model first", "error"); return; }

  const provider = cfg.default_provider ?? "openai";
  try {
    const res = await apiFetch("POST", "/v1/onboarding/validate-model", { provider_id: provider, model_id: modelId });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    cfg.default_model = modelId;
    toast("Default model saved", "ok");
    render();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function saveProvider(id) {
  const key     = document.getElementById(\`key-\${id}\`)?.value?.trim();
  const urlEl   = document.getElementById(\`url-\${id}\`);
  const flavorEl = document.getElementById(\`flavor-\${id}\`);
  const url     = urlEl?.value?.trim() || undefined;
  const flavor  = flavorEl?.value ?? "generic";

  if (!key) { toast("API key is required", "error"); return; }

  if (id === "openai" && flavor !== "generic" && !url) {
    toast("A base URL is required for this endpoint type", "error");
    return;
  }

  try {
    const body = {
      api_key: key,
      ...(url !== undefined ? { base_url: url } : {}),
      ...(id === "openai" ? { endpoint_flavor: flavor } : {}),
    };
    const res = await apiFetch("PUT", \`/admin/providers/\${id}\`, body);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    toast(\`\${providerLabel({ id, endpoint_flavor: flavor })} saved\`, "ok");
    await init();
  } catch (e) {
    toast(e.message, "error");
  }
}

async function removeProvider(id) {
  const p = providers.find(x => x.id === id);
  if (!confirm(\`Disconnect \${providerLabel(p ?? { id })}? This will remove the stored API key.\`)) return;
  try {
    const res = await apiFetch("DELETE", \`/admin/providers/\${id}\`);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    toast(\`Disconnected\`, "ok");
    await init();
  } catch (e) {
    toast(e.message, "error");
  }
}

function toggleAdvanced() {
  const content = document.getElementById("adv-content");
  const arrow   = document.getElementById("adv-arrow");
  if (!content || !arrow) return;
  const open = content.classList.toggle("open");
  arrow.textContent = open ? "▼" : "▶";
}

async function saveAdvanced() {
  const target = parseInt(document.getElementById("cfg-token-target")?.value ?? "", 10);
  const cap = parseInt(document.getElementById("cfg-history-cap")?.value ?? "", 10);
  const compactionMode = document.getElementById("cfg-compaction-mode")?.value ?? "aggressive";

  if (isNaN(target) || isNaN(cap)) { toast("Invalid values", "error"); return; }

  try {
    await Promise.all([
      apiFetch("PUT", "/admin/config/always_on_token_target", { value: target }),
      apiFetch("PUT", "/admin/config/managed_history_token_cap", { value: cap }),
      apiFetch("PUT", "/admin/config/compaction_mode", { value: compactionMode }),
    ]);
    cfg.always_on_token_target = target;
    cfg.managed_history_token_cap = cap;
    cfg.compaction_mode = compactionMode;
    toast("Advanced settings saved", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setExtractionEnabled(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/extraction_enabled", {
      value: enabled,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const track = document.getElementById("extraction-track");
    const thumb = document.getElementById("extraction-thumb");
    const label = document.getElementById("extraction-label");

    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform = \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) {
      label.textContent = enabled ? "Enabled" : "Paused";
      label.style.color = enabled ? "var(--ok)" : "var(--muted)";
    }

    toast(
      enabled ? "Extraction enabled" : "Extraction paused — existing beliefs still injected",
      "ok",
    );
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("extraction-enabled");
    if (cb) cb.checked = !enabled;
  }
}

function showTokenScreen(err) {
  app.innerHTML = \`<div class="screen"><div class="screen-inner">
  <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <h1>Tenure</h1>
    <p>Enter your API token to manage settings.</p>
    \${err ? \`<div class="err-msg">\${esc(err)}</div>\` : ""}
    <label for="tok">API Token</label>
    <input id="tok" type="password" placeholder="your-token-here" autocomplete="off">
    <button class="btn btn-primary" style="width:100%" onclick="handleToken()">Continue</button>
  </div></div>\`;
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

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function rotateToken() {
  if (!confirm("This will invalidate your current token immediately. Continue?")) return;
  try {
    const res = await apiFetch("POST", "/admin/token/rotate");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const newToken = data.token;
    alert(\`New token:\n\n\${newToken}\n\nCopy this now, then click OK to continue.\`);


    token = newToken;
    localStorage.setItem(STORAGE_KEY, newToken);


    window.location.href = \`/admin?token=\${encodeURIComponent(newToken)}\`;
  } catch (e) {
    toast(e.message, "error");
  }
}

async function exportBackup() {
  const passphrase = document.getElementById("export-passphrase")?.value ?? "";
  if (passphrase.length < 8) {
    toast("Passphrase must be at least 8 characters", "error");
    return;
  }
  try {
    const res = await apiFetch("POST", "/v1/backup/export", { passphrase });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = \`tenure-backup-\${Date.now()}.enc\`;
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById("export-passphrase").value = "";
    toast("Backup exported", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function importBackup() {
  const fileInput = document.getElementById("import-file");
  const file = fileInput?.files?.[0];
  const passphrase = document.getElementById("import-passphrase")?.value ?? "";

  if (!file) { toast("Select a backup file", "error"); return; }
  if (!passphrase) { toast("Passphrase is required", "error"); return; }

  const skipExisting = document.getElementById("import-skip-existing")?.checked ?? true;
  const importConfig = document.getElementById("import-config")?.checked ?? true;

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const res = await apiFetch("POST", "/v1/backup/import", {
      passphrase,
      archive: base64,
      skip_existing: skipExisting,
      import_config: importConfig,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const r = data.result;
    const resultEl = document.getElementById("import-result");
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.textContent = \`Imported \${r.beliefs_imported} beliefs (\${r.beliefs_skipped} skipped). \`
        + \`\${r.persona_restored ? "Persona restored. " : ""}\`
        + \`\${r.config_restored ? "Settings restored." : ""}\`;
    }

    document.getElementById("import-passphrase").value = "";
    toast("Backup imported", "ok");

    if (importConfig) {
      setTimeout(() => init(), 1500);
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

async function loadBackupPreview() {
  try {
    const res = await apiFetch("GET", "/v1/backup/preview");
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    const c = data.counts;
    const el = document.getElementById("backup-preview");
    if (el) {
      el.style.display = "block";
      document.getElementById("bp-beliefs").textContent = \`\${c.beliefs_active} active beliefs (\${c.beliefs} total)\`;
      document.getElementById("bp-sessions").textContent = \`\${c.sessions} sessions\`;
      document.getElementById("bp-persona").textContent = c.has_persona ? "Persona: ✓" : "Persona: not generated";
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

async function setStrictModelTiers(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/strict_model_tiers", { value: enabled });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    const track = document.getElementById("strict-tiers-track");
    const thumb = document.getElementById("strict-tiers-thumb");
    const label = document.getElementById("strict-tiers-label");
    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform = \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) { label.textContent = enabled ? "Enforced" : "Off"; label.style.color = enabled ? "var(--ok)" : "var(--muted)"; }
    toast(enabled ? "Strict tiers enforced" : "Strict tiers disabled", "ok");
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("strict-model-tiers");
    if (cb) cb.checked = !enabled;
  }
}

async function setScopeAutoDetect(enabled) {
  try {
    const res = await apiFetch("PUT", "/admin/config/scope_auto_detect", {
      value: enabled,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    const track = document.getElementById("scope-auto-track");
    const thumb = document.getElementById("scope-auto-thumb");
    const label = document.getElementById("scope-auto-label");

    if (track) track.style.background = enabled ? "var(--ok)" : "var(--border)";
    if (thumb) thumb.style.transform = \`translateX(\${enabled ? "21px" : "3px"})\`;
    if (label) {
      label.textContent = enabled ? "Auto-detect" : "Explicit only";
      label.style.color = enabled ? "var(--ok)" : "var(--muted)";
    }

    toast(
      enabled
        ? "Scope auto-detection enabled"
        : "Scope set to explicit only — use !scope to set manually",
      "ok",
    );
  } catch (e) {
    toast(e.message, "error");
    const cb = document.getElementById("scope-auto-detect");
    if (cb) cb.checked = !enabled;
  }
}

async function runCompaction() {
  const btn = document.getElementById("compact-btn");
  const status = document.getElementById("compact-status");
  if (btn) { btn.disabled = true; btn.textContent = "Running…"; }
  try {
    const res = await apiFetch("POST", "/admin/maintenance/compact");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);
    if (status) status.innerHTML = \`<span style="color:var(--ok)">Compaction complete.</span>\`;
    toast("Compaction complete", "ok");
  } catch (e) {
    toast(e.message, "error");
    if (status) status.innerHTML = \`<span style="color:var(--danger)">\${esc(e.message)}</span>\`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Run compaction now"; }
  }
}

async function loadPersona() {
  try {
    const res = await apiFetch("GET", "/v1/persona");
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    const el = document.getElementById("persona-universal");
    if (el) el.textContent = data.universal || "(No persona generated yet — run onboarding or wait for extraction to build one)";
  } catch (e) {
    const el = document.getElementById("persona-universal");
    if (el) el.textContent = "(Could not load persona)";
  }
}

async function loadErrors() {
  const el = document.getElementById("error-log");
  if (!el) return;
  try {
    const res = await apiFetch("GET", "/admin/errors?limit=10");
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    if (data.errors.length === 0) {
      el.innerHTML = \`<span style="color:var(--ok)">No errors recorded.</span>\`;
      return;
    }

    el.innerHTML = data.errors.map(e => \`
      <div style="background:var(--surface2);border-radius:4px;padding:.5rem .65rem;margin-bottom:.35rem;border-left:2px solid \${e.severity === 'error' ? 'var(--danger)' : e.severity === 'critical' ? 'var(--danger)' : '#d4a84b'}">
        <div style="display:flex;justify-content:space-between;gap:.5rem">
          <span style="color:var(--text);font-size:.78rem">\${esc(e.stage)}</span>
          <span style="font-size:.72rem">\${new Date(e.occurred_at).toLocaleString()}</span>
        </div>
        <div style="margin-top:.2rem;color:var(--text);font-size:.8rem;word-break:break-word">\${esc(e.message)}</div>
        \${e.provider ? \`<span style="font-size:.7rem">provider: \${esc(e.provider)}</span>\` : ""}
      </div>
    \`).join("");
  } catch (e) {
    if (el) el.textContent = \`Failed to load: \${e.message}\`;
  }
}

async function copyErrors() {
  try {
    const res = await apiFetch("GET", "/admin/errors?limit=5");
    const data = await res.json();
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);

    const text = data.errors.map(e =>
      \`[\${e.occurred_at}] \${e.severity}/\${e.stage}: \${e.message}\${e.provider ? \` (\${e.provider})\` : ""}\${e.session_id ? \` session=\${e.session_id}\` : ""}\`
    ).join("\\n");

    await navigator.clipboard.writeText(text || "No errors recorded.");
    toast("Copied to clipboard", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function regeneratePersona() {
  try {
    const res = await apiFetch("POST", "/v1/persona/regenerate");
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    toast("Persona regeneration started", "ok");
    setTimeout(loadPersona, 3000);
  } catch (e) {
    toast(e.message, "error");
  }
}

function toast(msg, type) {
  const el = document.createElement("div");
  el.className = \`toast toast-\${type}\`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

token ? init() : showTokenScreen();
<\/script>
</body>
</html>`;
}

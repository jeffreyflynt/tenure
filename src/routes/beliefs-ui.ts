import type { FastifyInstance } from "fastify";

export function registerBeliefsUiRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { token?: string } }>(
    "/beliefs",
    async (req, reply) => {
      reply.header("content-type", "text/html; charset=utf-8");
      return reply.send(buildBeliefsHtml(req.query.token ?? ""));
    },
  );
}

function buildBeliefsHtml(embeddedToken: string): string {
  const tokenJS = embeddedToken
    ? JSON.stringify(embeddedToken).replace(/</g, "\\u003c")
    : `new URLSearchParams(location.search).get("token") || localStorage.getItem("mp_token") || ""`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" type="image/x-icon" href="/assets/favicon.ico">
<title>World Model · Tenure</title>
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
.nav-right { margin-left: auto; display: flex; align-items: center; gap: .75rem; padding: .5rem 0; }
.count { font-size: .8rem; color: var(--muted); }
.header { display: flex; align-items: center; gap: 1rem; padding: .875rem 2rem; border-bottom: 1px solid var(--border); }
.header h1 { font-size: .95rem; font-weight: 500; }
.header-right { margin-left: auto; display: flex; align-items: center; gap: .75rem; }

.filters { display: flex; align-items: center; gap: .75rem; padding: .75rem 2rem; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.main { padding: 1.5rem 2rem; max-width: 860px; margin: 0 auto; }
.section { margin-bottom: 2.5rem; }
.section-title { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: .625rem; }

.tabs { display: flex; gap: 2px; }
.tab { padding: .3rem .65rem; border-radius: 4px; font-size: .78rem; cursor: pointer; border: none; color: var(--muted); background: transparent; font-family: inherit; transition: all .15s; }
.tab.active { background: var(--surface); color: var(--text); }
.tab:hover:not(.active) { color: var(--text); }

.input-sm { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .8rem; padding: .3rem .65rem; outline: none; }
.input-sm:focus { border-color: var(--accent); }
select.input-sm option { background: #1a1a1a; }

.belief-card { background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: .875rem 1rem; margin-bottom: .4rem; transition: border-color .15s; }
.belief-card:hover { border-color: #3a3a3a; }
.belief-card.pinned { border-left: 2px solid var(--accent); }
.bh { display: flex; align-items: flex-start; gap: .6rem; margin-bottom: .4rem; flex-wrap: wrap; }
.bname { font-size: .875rem; font-weight: 500; flex: 1; word-break: break-word; min-width: 0; }
.badge { display: inline-block; font-size: .68rem; padding: .15rem .45rem; border-radius: 3px; font-weight: 600; white-space: nowrap; }
.s-active     { background: #0d2a1a; color: #4dda8a; }
.s-inferred   { background: #0d1a2a; color: #5aa8ff; }
.s-exploratory{ background: #2a1f0d; color: #d4a84b; }
.s-superseded { background: #2a0d0d; color: #cc5555; }
.conf { font-size: .7rem; color: var(--muted); }
.bcontent { font-size: .85rem; line-height: 1.55; margin-bottom: .4rem; }
.bwhy { font-size: .775rem; color: var(--muted); font-style: italic; line-height: 1.4; margin-bottom: .6rem; }
.bactions { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }

.btn { padding: .3rem .65rem; border-radius: 5px; font-size: .78rem; cursor: pointer; border: 1px solid var(--border); font-family: inherit; color: var(--muted); background: transparent; transition: all .15s; }
.btn:hover { color: var(--text); border-color: #444; }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { opacity: .85; color: #fff; }
.btn-pin { border-color: transparent; }
.btn-pin.active { color: var(--accent); }
.btn-pin:hover { color: var(--accent); border-color: transparent; }
.btn-danger { color: var(--danger); border-color: transparent; }
.btn-danger:hover { border-color: var(--danger); }
.btn-danger-solid { background: #3a0d0d; color: var(--danger); border-color: var(--danger); }
.btn-danger-solid:hover { background: #4a1010; }
.spacer { flex: 1; }

.overlay { position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; width: 100%; max-width: 520px; max-height: 85vh; overflow-y: auto; padding: 1.5rem; }
.modal h2 { font-size: .95rem; font-weight: 500; margin-bottom: 1.25rem; }
.field { margin-bottom: .875rem; }
.field label { display: block; font-size: .75rem; color: var(--muted); margin-bottom: .3rem; }
.field input, .field textarea, .field select { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-family: inherit; font-size: .85rem; padding: .55rem .75rem; outline: none; }
.field textarea { min-height: 80px; resize: vertical; line-height: 1.5; }
.field input:focus, .field textarea:focus, .field select:focus { border-color: var(--accent); }
.field select option { background: var(--surface2); }
.checkbox-row { display: flex; align-items: center; gap: .5rem; font-size: .85rem; cursor: pointer; margin-bottom: 1.25rem; }
.checkbox-row input[type=checkbox] { width: auto; cursor: pointer; accent-color: var(--accent); }
.modal-footer { display: flex; justify-content: flex-end; gap: .625rem; margin-top: 1.25rem; border-top: 1px solid var(--border); padding-top: 1rem; }
.modal-body { font-size: .85rem; color: var(--muted); line-height: 1.55; margin-bottom: 1rem; }

.h-meta { font-size: .7rem; color: var(--muted); margin-bottom: 1rem; }
.h-entry { padding: .625rem 0; border-bottom: 1px solid var(--border); }
.h-entry:last-child { border-bottom: none; }
.h-row { display: flex; justify-content: space-between; gap: .5rem; margin-bottom: .2rem; }
.h-trigger { font-size: .8rem; color: var(--text); }
.h-date { font-size: .75rem; color: var(--muted); white-space: nowrap; }
.h-prev { font-size: .775rem; color: var(--muted); background: var(--surface2); padding: .375rem .6rem; border-radius: 4px; margin-top: .25rem; line-height: 1.4; }

.screen { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
.screen-inner { width: 100%; max-width: 380px; }
.screen-inner h1 { font-size: 1.1rem; font-weight: 500; margin-bottom: .375rem; }
.screen-inner p { color: var(--muted); font-size: .875rem; margin-bottom: 1.5rem; line-height: 1.5; }
.screen-inner label { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .375rem; }
.screen-inner input { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-family: monospace; font-size: .9rem; padding: .75rem 1rem; outline: none; margin-bottom: .75rem; }
.screen-inner input:focus { border-color: var(--accent); }
.err-msg { color: var(--danger); font-size: .8rem; margin-bottom: .75rem; }
.loading { text-align: center; padding: 4rem 2rem; color: var(--muted); font-size: .875rem; }
.empty { font-size: .8rem; color: var(--muted); padding: .375rem 0; }

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
const TYPE_LABELS = { preference: "Preferences", entity: "Entities", decision: "Decisions", open_question: "Open Questions" };
const TYPE_ORDER  = ["preference", "decision", "entity", "open_question"];

let token = ${tokenJS};
let beliefs     = [];
let filterType  = "all";
let filterStatus = "default";
let searchQuery  = "";
let editId       = null;
let historyData  = null;
let deleteId     = null;
let filterScope = "all";
let availableScopes = [];

const app = document.getElementById("app");

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
    const params = new URLSearchParams({ limit: "200" });
    if (filterStatus === "superseded") params.set("status", "superseded");
    const res = await apiFetch("GET", \`/v1/beliefs?\${params}\`);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    beliefs = data.beliefs ?? [];
    availableScopes = [...new Set(beliefs.flatMap(b => b.scope ?? []))].sort();
    render();
  } catch (e) {
    if (e.message !== "unauthorized") {
      app.innerHTML = \`<div class="loading">
        <p style="color:var(--danger);margin-bottom:1rem">\${esc(e.message)}</p>
        <button class="btn" data-action="retry">Retry</button>
      </div>\`;
    }
  }
}

function getFiltered() {
  const q = searchQuery.toLowerCase();
  return beliefs.filter(b => {
    if (filterType !== "all" && b.type !== filterType) return false;
    if (filterScope !== "all" && !(b.scope ?? []).includes(filterScope)) return false;
    if (q && !\`\${b.canonical_name} \${b.content} \${b.why_it_matters}\`.toLowerCase().includes(q)) return false;
    return true;
  });
}

document.addEventListener("change", e => {
  if (e.target.id === "status-filter") setStatus(e.target.value);
  if (e.target.id === "scope-filter") { filterScope = e.target.value; render(); }
});

function render() {
  if (filterType === "import") {
    renderImportPanel();
    return;
  }
  const filtered = getFiltered();
  const byType   = Object.fromEntries(TYPE_ORDER.map(t => [t, []]));
  for (const b of filtered) (byType[b.type] ?? (byType[b.type] = [])).push(b);

  const types = filterType === "all" ? TYPE_ORDER.filter(t => byType[t]?.length) : [filterType];
  const sections = types.map(t => \`
    <div class="section">
      <div class="section-title">\${TYPE_LABELS[t] ?? t} <span style="opacity:.4;font-weight:400">(\${byType[t]?.length ?? 0})</span></div>
      \${(byType[t] ?? []).map(beliefCard).join("") || '<div class="empty">None</div>'}
    </div>\`).join("") || '<div class="loading">No beliefs match your filters.</div>';

  app.innerHTML = \`
    <nav class="nav">
       <a class="nav-brand" href="/beliefs">
        <img src="/assets/tenure-logo.png" alt="Tenure" height="24" style="vertical-align:middle">
      </a>
      <div class="nav-links">
        <a class="nav-link active" href="/beliefs">World Model</a>
        <a class="nav-link" href="/admin">Settings</a>
        <a class="nav-link" href="/onboarding">Onboarding</a>
      </div>
      <div class="nav-right">
        <span class="count">\${beliefs.length} belief\${beliefs.length === 1 ? "" : "s"}</span>
        <button class="btn" data-action="set-type" data-value="import">Import</button>
      </div>
    </nav>
    <div id="extraction-banner"></div>
    <div class="filters">
      <div class="tabs">
        \${["all","preference","decision","entity","open_question"].map(t =>
          \`<button class="tab\${filterType === t ? " active" : ""}" data-action="set-type" data-value="\${t}">
            \${t === "all" ? "All" : t === "import" ? "Import" : TYPE_LABELS[t]}
          </button>\`
        ).join("")}
      </div>
      <span class="spacer"></span>
      <select id="scope-filter" class="input-sm" style="max-width:180px">
        <option value="all"\${filterScope === "all" ? " selected" : ""}>All scopes</option>
        \${availableScopes.map(s => \`<option value="\${esc(s)}"\${filterScope === s ? " selected" : ""}>\${esc(s)}</option>\`).join("")}
      </select>
      <select id="status-filter" class="input-sm">
        <option value="default"\${filterStatus === "default" ? " selected" : ""}>Active</option>
        <option value="superseded"\${filterStatus === "superseded" ? " selected" : ""}>Superseded</option>
      </select>
      <input id="search-input" class="input-sm" type="search" placeholder="Search…" value="\${esc(searchQuery)}" style="width:180px">
    </div>
    <div class="main">\${sections}</div>
  \`;

  apiFetch("GET", "/admin/config").then(r => r.json()).then(cfg => {
    const banner = document.getElementById("extraction-banner");
    if (banner && cfg.extraction_enabled === false) {
      banner.innerHTML = \`
        <div style="background:#2a1f0d;border-bottom:1px solid #5a3a0d;padding:.6rem 2rem;font-size:.8rem;color:#d4a84b">
          Belief extraction is paused — new beliefs won't be extracted from conversations.
          <a href="/admin" style="color:#d4a84b;margin-left:.5rem">Re-enable in Settings →</a>
        </div>
      \`;
    }
  }).catch(() => {});

  renderModal();
}

function beliefCard(b) {
  return \`
    <div class="belief-card\${b.pinned ? " pinned" : ""}" data-id="\${esc(b.id)}">
      <div class="bh">
        <span class="bname">\${esc(b.canonical_name ?? "")}</span>
        <span class="badge s-\${b.epistemic_status}">\${b.epistemic_status}</span>
        \${b.confidence != null ? \`<span class="conf">\${Math.round(b.confidence * 100)}%</span>\` : ""}
      </div>
      <div class="bcontent">\${esc(b.content ?? "")}</div>
      \${b.why_it_matters ? \`<div class="bwhy">\${esc(b.why_it_matters)}</div>\` : ""}
      <div class="bactions">
        <button class="btn btn-pin\${b.pinned ? " active" : ""}" data-action="toggle-pin" data-id="\${esc(b.id)}">\${b.pinned ? "📌 Pinned" : "📌 Pin"}</button>
        <button class="btn" data-action="open-edit" data-id="\${esc(b.id)}">Edit</button>
        <button class="btn" data-action="open-history" data-id="\${esc(b.id)}">History</button>
        <span class="spacer"></span>
        <button class="btn btn-danger" data-action="open-delete" data-id="\${esc(b.id)}">Remove</button>
      </div>
    </div>\`;
}



function renderModal() {
  let html = "";
  if (editId)      { const b = beliefs.find(x => x.id === editId);   if (b)  html = editModal(b); }
  else if (historyData) html = historyModal(historyData);
  else if (deleteId) { const b = beliefs.find(x => x.id === deleteId); if (b) html = deleteModal(b); }
  if (!html) return;

  const el = document.createElement("div");
  el.className = "overlay";
  el.setAttribute("data-action", "close-modal");
  el.innerHTML = html;
  app.appendChild(el);
}

function editModal(b) {
  return \`<div class="modal">
    <h2>Edit belief</h2>
    <div class="field"><label>Canonical name</label>
      <input id="m-name" value="\${esc(b.canonical_name ?? "")}"></div>
    <div class="field"><label>Content</label>
      <textarea id="m-content">\${esc(b.content ?? "")}</textarea></div>
    <div class="field"><label>Why it matters</label>
      <input id="m-why" value="\${esc(b.why_it_matters ?? "")}"></div>
    <div class="field"><label>Epistemic status</label>
      <select id="m-status">\${["active","inferred","exploratory","superseded"].map(s =>
        \`<option\${b.epistemic_status === s ? " selected" : ""}>\${s}</option>\`).join("")}
      </select>
    </div>
    <label class="checkbox-row">
      <input type="checkbox" id="m-pinned"\${b.pinned ? " checked" : ""}> Always inject (pinned)
    </label>
    <div class="modal-footer">
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn btn-primary" data-action="save-edit" data-id="\${esc(b.id)}">Save</button>
    </div>
  </div>\`;
}

function historyModal({ belief, changeLog, createdAt }) {
  const entries = changeLog.slice().reverse();
  return \`<div class="modal">
    <h2>\${esc(belief.canonical_name)}</h2>
    <div class="h-meta">Created \${fmtDate(createdAt)}</div>
    \${entries.length === 0 ? '<p class="empty">No changes recorded yet.</p>'
      : entries.map(e => \`
        <div class="h-entry">
          <div class="h-row">
            <span class="h-trigger">\${esc((e.trigger ?? "").replace(/_/g, " "))}</span>
            <span class="h-date">\${fmtDate(e.changed_at)}</span>
          </div>
          \${e.previous_content != null ? \`<div class="h-prev">Was: \${esc(e.previous_content)}</div>\` : ""}
          \${e.previous_epistemic_status != null ? \`<div class="h-prev">Status was: \${esc(e.previous_epistemic_status)}</div>\` : ""}
        </div>\`).join("")}
    <div class="modal-footer">
      <button class="btn btn-primary" data-action="close-modal">Close</button>
    </div>
  </div>\`;
}

function deleteModal(b) {
  return \`<div class="modal">
    <h2>Remove belief?</h2>
    <p class="modal-body"><strong>\${esc(b.canonical_name)}</strong> will be marked superseded and stop injecting.
      It is never deleted — switch to the Superseded filter to find it again.</p>
    <div class="modal-footer">
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn btn-danger-solid" data-action="confirm-delete" data-id="\${esc(b.id)}">Remove</button>
    </div>
  </div>\`;
}



function setType(t)   { filterType = t; render(); }
function setStatus(s) { filterStatus = s; init(); }
function setSearch(q) { searchQuery = q; render(); }

function openEdit(id)    { editId = id; historyData = null; deleteId = null; render(); }
function openDelete(id)  { deleteId = id; editId = null; historyData = null; render(); }
function closeModal()    { editId = null; historyData = null; deleteId = null; render(); }

async function saveEdit() {
  if (!editId) return;
  const id = editId;
  const patch = {
    canonical_name:    document.getElementById("m-name")?.value?.trim(),
    content:           document.getElementById("m-content")?.value?.trim(),
    why_it_matters:    document.getElementById("m-why")?.value?.trim(),
    epistemic_status:  document.getElementById("m-status")?.value,
    pinned:            document.getElementById("m-pinned")?.checked ?? false,
  };
  try {
    const res = await apiFetch("PATCH", \`/v1/beliefs/\${id}\`, patch);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    const idx = beliefs.findIndex(b => b.id === id);
    if (idx !== -1) beliefs[idx] = data.belief;
    closeModal();
    toast("Saved", "ok");
  } catch (e) {
    toast(e.message, "error");
  }
}

async function togglePin(id) {
  const b = beliefs.find(x => x.id === id);
  if (!b) return;
  try {
    const res = await apiFetch("PATCH", \`/v1/beliefs/\${id}\`, { pinned: !b.pinned });
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    const idx = beliefs.findIndex(x => x.id === id);
    if (idx !== -1) beliefs[idx] = data.belief;
    render();
  } catch (e) { toast(e.message, "error"); }
}

async function openHistory(id) {
  const belief = beliefs.find(b => b.id === id);
  if (!belief) return;
  try {
    const res = await apiFetch("GET", \`/v1/beliefs/\${id}/history\`);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();
    editId = null; deleteId = null;
    historyData = { belief, changeLog: data.change_log ?? [], createdAt: data.created_at };
    render();
  } catch (e) { toast(e.message, "error"); }
}

async function confirmDelete() {
  if (!deleteId) return;
  const id = deleteId;
  try {
    const res = await apiFetch("DELETE", \`/v1/beliefs/\${id}\`);
    if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
    beliefs = beliefs.filter(b => b.id !== id);
    closeModal();
    toast("Removed", "ok");
  } catch (e) { toast(e.message, "error"); }
}

function showTokenScreen(err) {
  app.innerHTML = \`<div class="screen"><div class="screen-inner">
  <img src="/assets/tenure-logo.png" alt="Tenure" class="logo">
    <h1>Tenure</h1>
    <p>Enter your API token to view your world model.</p>
    \${err ? \`<div class="err-msg">\${esc(err)}</div>\` : ""}
    <label for="tok">API Token</label>
    <input id="tok" type="password" placeholder="your-token-here" autocomplete="off">
    <button class="btn btn-primary" data-action="token-submit" style="width:100%">Continue</button>
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

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"numeric" }); }
  catch { return String(d ?? "—"); }
}

function toast(msg, type) {
  const el = document.createElement("div");
  el.className = \`toast toast-\${type}\`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

document.addEventListener("click", e => {
  if (e.target.classList.contains("overlay")) { closeModal(); return; }
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.classList.contains("overlay")) return;
  const { action, id, value } = el.dataset;
  switch (action) {
    case "set-type":       setType(value); break;
    case "open-edit":      openEdit(id); break;
    case "open-history":   openHistory(id); break;
    case "open-delete":    openDelete(id); break;
    case "toggle-pin":     togglePin(id); break;
    case "save-edit":      saveEdit(); break;
    case "close-modal":    closeModal(); break;
    case "confirm-delete": confirmDelete(); break;
    case "token-submit":   handleToken(); break;
    case "retry":          init(); break;
  }
});

document.addEventListener("change", e => {
  if (e.target.id === "status-filter") setStatus(e.target.value);
});

document.addEventListener("input", e => {
  if (e.target.id === "search-input") setSearch(e.target.value);
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && (editId || historyData || deleteId)) closeModal();
});

function renderImportPanel() {
  app.innerHTML = \`
    <nav class="nav">
      <a class="nav-brand" href="/beliefs">
        <img src="/assets/tenure-logo.png" alt="Tenure" height="24" style="vertical-align:middle">
      </a>
      <div class="nav-links">
        <a class="nav-link active" href="/beliefs">World Model</a>
        <a class="nav-link" href="/admin">Settings</a>
        <a class="nav-link" href="/onboarding">Onboarding</a>
      </div>
    </nav>
    <div class="filters">
      <div class="tabs">
        \${["all", "preference", "decision", "entity", "open_question"]
          .map(
            (t) =>
              \`<button class="tab" data-action="set-type" data-value="\${t}">
            \${t === "all" ? "All" : TYPE_LABELS[t]}
          </button>\`,
          )
          .join("")}
      </div>
      <div class="nav-right" style="margin-left:auto">
        <button class="btn btn-primary" data-action="set-type" data-value="import">Import</button>
      </div>
    </div>
    <div class="main">
      <div class="section">
        <div class="section-title">Import facts about you</div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:7px;padding:1.25rem">
          <p style="font-size:.82rem;color:var(--muted);margin-bottom:1.25rem;line-height:1.5">
            Paste anything — a skills file, a bio, bullet points, freeform notes.
            Tenure will extract beliefs exactly as it would from a conversation.
            Importing the same document twice may create duplicates; the compaction
            worker will merge them over time.
          </p>
          <div class="field">
            <label>Source label <span style="opacity:.5">(optional)</span></label>
            <input id="import-source" type="text" placeholder="e.g. SKILLS.md, personal notes">
          </div>
          <div class="field">
            <label>Scope <span style="opacity:.5">(optional)</span></label>
            <input id="import-scope-tag" type="text"
              placeholder="e.g. project:my-app — leave blank for universal">
            <div class="hint" style="font-size:.75rem;color:var(--muted);margin-top:.3rem">
              If this document belongs to a specific project, enter its tag here (e.g. project:my-app). Leave blank and Tenure will infer scope from the content.
            </div>
          </div>
          <div class="field">
            <label>Document text</label>
            <textarea id="import-text" style="min-height:200px;resize:vertical"
              placeholder="Paste your text here… or drag and drop a .md or .txt file"></textarea>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:.625rem;margin-top:1rem">
            <button class="btn" onclick="clearImport()">Clear</button>
            <button class="btn btn-primary" id="import-btn" onclick="submitImport()">
              Extract beliefs
            </button>
          </div>
          <div id="import-status" style="margin-top:.875rem;font-size:.82rem"></div>
        </div>
      </div>
    </div>
  \`;

  const dropzone = document.getElementById("import-text");
  if (dropzone) {
    dropzone.addEventListener("dragover", e => e.preventDefault());
    dropzone.addEventListener("drop", async e => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      const text = await file.text();
      dropzone.value = text;
      const src = document.getElementById("import-source");
      if (src && !src.value) src.value = file.name;
    });
  }
}

async function submitImport() {
  const text = document.getElementById("import-text")?.value?.trim();
  const sourceLabel = document.getElementById("import-source")?.value?.trim();
  const scopeTag = document.getElementById("import-scope-tag")?.value?.trim();

  if (!text) { toast("Paste some text first", "error"); return; }

  const btn = document.getElementById("import-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Extracting…"; }

  const status = document.getElementById("import-status");

  try {
    const res = await apiFetch("POST", "/v1/beliefs/ingest", {
      text,
      ...(sourceLabel ? { source_label: sourceLabel } : {}),
      ...(scopeTag ? { scope: [scopeTag] } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? \`HTTP \${res.status}\`);

    if (status) {
      status.innerHTML = \`<span style="color:var(--ok)">
        Extraction queued — new beliefs will appear in your world model within a few seconds.
      </span>\`;
    }

    const textEl = document.getElementById("import-text");
    const srcEl = document.getElementById("import-source");
    const scopeEl = document.getElementById("import-scope-tag");
    if (textEl) textEl.value = "";
    if (srcEl) srcEl.value = "";
    if (scopeEl) scopeEl.value = "";

    setTimeout(() => {
      filterType = "all";
      init();
    }, 2000);
  } catch (e) {
    toast(e.message, "error");
    if (status) status.innerHTML = \`<span style="color:var(--danger)">\${esc(e.message)}</span>\`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Extract beliefs"; }
  }
}

function clearImport() {
  const t = document.getElementById("import-text");
  const s = document.getElementById("import-source");
  const sc = document.getElementById("import-scope-tag");
  const st = document.getElementById("import-status");
  if (t) t.value = "";
  if (s) s.value = "";
  if (sc) sc.value = "";
  if (st) st.innerHTML = "";
}

token ? init() : showTokenScreen();
<\/script>
</body>
</html>`;
}

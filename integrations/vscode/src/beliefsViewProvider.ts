import * as vscode from "vscode";
import type { TokenStore } from "./tokenStore.js";
import WebSocket from "ws";

interface BeliefSummary {
  id: string;
  type: string;
  canonical_name: string;
  content: string;
  why_it_matters: string;
  epistemic_status: string;
  confidence: number;
  pinned: boolean;
  scope: string[];
  aliases: string[];
  origin_context?: {
    active_file: string | null;
    language: string | null;
    project_scope: string | null;
  } | null;
}

type ServerMessage =
  | { type: "beliefs_snapshot"; beliefs: BeliefSummary[]; scope: string }
  | { type: "belief_upserted"; belief: BeliefSummary }
  | { type: "belief_superseded"; id: string }
  | {
      type: "contradiction_detected";
      contradiction: {
        belief_ids: [string, string];
        reason: string;
        scope: string;
      };
    }
  | { type: "patch_ack"; id: string; belief: BeliefSummary }
  | { type: "record_ack"; belief: BeliefSummary }
  | { type: "scope_confirmed"; scope: string; active_file: string | null }
  | { type: "error"; request_type: string; message: string };

type ClientMessage =
  | { type: "subscribe"; scope: string }
  | { type: "fetch_beliefs"; scope: string; active_file: string | null }
  | { type: "fetch_file_beliefs"; file_path: string; scope: string }
  | {
      type: "patch_belief";
      id: string;
      patch: {
        content?: string;
        epistemic_status?: string;
        pinned?: boolean;
        canonical_name?: string;
        why_it_matters?: string;
        aliases?: string[];
      };
    }
  | {
      type: "record_belief";
      belief_type: "decision" | "preference" | "entity" | "relation";
      content: string;
      why_it_matters: string;
      scope: string[];
      canonical_name: string;
      active_file: string | null;
      active_language: string | null;
      project_scope: string | null;
    }
  | { type: "rename_file"; old_path: string; new_path: string }
  | {
      type: "workspace_state";
      workspace_root: string;
      project_name: string;
      git_remote: string | null;
      active_file: string | null;
      active_language: string | null;
    }
  | { type: "file_meta"; path: string; size_bytes: number };

const BASE_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export class TenureBeliefsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private socket: WebSocket | null = null;
  private currentScope: string | null = null;
  private currentActiveFile: string | null = null;
  private currentActiveFileUri: vscode.Uri | null = null;
  private beliefs: BeliefSummary[] = [];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private onConnectedCallback: (() => void) | null = null;
  private pendingWorkspaceState:
    | Parameters<TenureBeliefsViewProvider["sendWorkspaceState"]>[0]
    | null = null;

  private noWorkspace = false;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.buildShell();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === "openDashboard") {
        vscode.commands.executeCommand("tenure.openBeliefs");
      }
      if (msg.command === "pinBelief") {
        this.togglePin(msg.id, msg.pinned);
      }
      if (msg.command === "ready") {
        if (this.noWorkspace) {
          this.showNoWorkspace();
        } else {
          this.pushState();
        }
      }
      if (msg.command === "recordBelief") {
        const scope = this.currentScope
          ? [this.currentScope]
          : ["user:universal"];
        this.recordBelief(msg.content, msg.why, scope, msg.beliefType);
      }
    });

    this.ensureConnected();
  }

  async refresh(projectName: string, activeFile: string | null): Promise<void> {
    const scope = `project:${this.slugify(projectName)}`;
    this.currentActiveFile = activeFile;

    const scopeChanged = scope !== this.currentScope;
    this.currentScope = scope;

    await this.ensureConnected();

    if (scopeChanged) {
      this.send({ type: "subscribe", scope });
    }

    this.send({ type: "fetch_beliefs", scope, active_file: activeFile });
  }

  async reconnect(): Promise<void> {
    this.closeSocket();
    await this.ensureConnected();
    if (this.currentScope) {
      this.send({ type: "subscribe", scope: this.currentScope });
      this.send({
        type: "fetch_beliefs",
        scope: this.currentScope,
        active_file: this.currentActiveFile,
      });
    }
  }

  openRecordForm(): void {
    this.view?.webview.postMessage({ type: "open_form" });
  }

  recordBelief(
    content: string,
    whyItMatters: string,
    scope: string[],
    beliefType: "decision" | "preference" | "entity" | "relation" = "decision",
  ): void {
    const canonicalName = content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .slice(0, 5)
      .join("_");

    this.ensureConnected()
      .then(() => {
        this.send({
          type: "record_belief",
          belief_type: beliefType,
          content,
          why_it_matters: whyItMatters,
          scope,
          canonical_name: canonicalName,
          active_file: this.currentActiveFile,
          active_language: this.pendingWorkspaceState?.active_language ?? null,
          project_scope: this.currentScope,
        });
      })
      .catch(() => {});
  }

  setOnConnectedCallback(cb: () => void): void {
    this.onConnectedCallback = cb;
  }

  sendWorkspaceState(state: {
    workspace_root: string;
    project_name: string;
    git_remote: string | null;
    active_file: string | null;
    active_language: string | null;
  }): void {
    this.pendingWorkspaceState = state;
    this.send({ type: "workspace_state", ...state });
  }

  sendRenameFile(oldPath: string, newPath: string): void {
    this.send({ type: "rename_file", old_path: oldPath, new_path: newPath });
  }

  sendFileMeta(path: string, sizeBytes: number): void {
    this.send({ type: "file_meta", path, size_bytes: sizeBytes });
  }

  setNoWorkspace(value: boolean): void {
    this.noWorkspace = value;
    if (value) {
      this.showNoWorkspace();
    }
  }

  showNoWorkspace(): void {
    this.view?.webview.postMessage({ type: "no_workspace" });
  }

  showDisconnected(): void {
    this.view?.webview.postMessage({ type: "disconnected" });
  }

  sendFetchFileBeliefs(
    filePath: string,
    scope: string,
    fileUri: vscode.Uri,
  ): void {
    this.currentActiveFileUri = fileUri;
    this.send({ type: "fetch_file_beliefs", file_path: filePath, scope });
  }

  async ensureConnected(): Promise<void> {
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const token = await this.tokenStore.get();
    if (!token) return;

    const cfg = vscode.workspace.getConfiguration("tenure");
    const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");
    this.openSocket(baseUrl, token);
  }

  dispose(): void {
    this.disposed = true;
    this.closeSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  private openSocket(baseUrl: string, token: string): void {
    if (this.disposed) return;

    const wsUrl = baseUrl.replace(/^http/, "ws") + "/v1/beliefs/ws";

    const socket = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.onConnectedCallback?.();
      this.pendingWorkspaceState = null;
      if (this.currentScope) {
        this.send({ type: "subscribe", scope: this.currentScope });
        this.send({
          type: "fetch_beliefs",
          scope: this.currentScope,
          active_file: this.currentActiveFile,
        });
      }
    });

    socket.on("message", (raw) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (!this.disposed) {
        if (!this.currentScope) {
          this.showDisconnected();
        }
        this.scheduleReconnect();
      }
    });

    socket.on("error", () => {});
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "beliefs_snapshot": {
        if (msg.beliefs.length > 0) {
          this.beliefs = msg.beliefs;
          this.pushState();
        }
        break;
      }
      case "belief_upserted": {
        const idx = this.beliefs.findIndex((b) => b.id === msg.belief.id);
        if (idx !== -1) this.beliefs[idx] = msg.belief;
        else this.beliefs.unshift(msg.belief);
        this.pushState();
        break;
      }
      case "belief_superseded": {
        this.beliefs = this.beliefs.filter((b) => b.id !== msg.id);
        this.pushState();
        break;
      }
      case "record_ack": {
        const idx = this.beliefs.findIndex((b) => b.id === msg.belief.id);
        if (idx !== -1) this.beliefs[idx] = msg.belief;
        else this.beliefs.unshift(msg.belief);
        this.pushState();
        break;
      }
      case "patch_ack": {
        const idx = this.beliefs.findIndex((b) => b.id === msg.id);
        if (idx !== -1) {
          this.beliefs[idx] = msg.belief;
          this.pushState();
        }
        break;
      }
      case "scope_confirmed": {
        const scope = msg.scope;
        const scopeChanged = scope !== this.currentScope;
        this.currentScope = scope;
        this.currentActiveFile = msg.active_file;
        if (scopeChanged) {
          this.send({ type: "subscribe", scope });
        }
        if (msg.active_file) {
          this.send({
            type: "fetch_file_beliefs",
            file_path: msg.active_file,
            scope,
          });
        } else {
          this.send({ type: "fetch_beliefs", scope, active_file: null });
        }
        break;
      }
      case "contradiction_detected": {
        this.view?.webview.postMessage(msg);
        break;
      }
      case "error": {
        this.view?.webview.postMessage(msg);
        break;
      }
    }
  }

  /**
   * Pushes the current beliefs array and scope label to the webview.
   * The webview script owns all DOM updates from this point on.
   */
  private pushState(): void {
    this.view?.webview.postMessage({
      type: "state",
      scope: this.currentScope ?? "No scope resolved",
      beliefs: this.beliefs,
    });
  }

  private togglePin(id: string, currentlyPinned: boolean): void {
    this.send({
      type: "patch_belief",
      id,
      patch: { pinned: !currentlyPinned },
    });
  }

  private send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  private closeSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_MS,
    );
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.ensureConnected().catch(() => {});
    }, delay);
  }

  /**
   * The static HTML shell. Set once in resolveWebviewView and never replaced.
   * All updates arrive via postMessage and are applied with DOM operations.
   */
  private buildShell(): string {
    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  .scope { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; font-family: monospace; }
  .belief { padding: 8px; margin-bottom: 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
  .belief.pinned { border-left: 2px solid var(--vscode-charts-green); }
  .belief-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; }
  .name { font-weight: 600; }
  .pin-btn { background: none; border: none; cursor: pointer; color: var(--vscode-foreground); font-size: 14px; padding: 0 2px; line-height: 1; }
  .content { margin-bottom: 4px; line-height: 1.4; }
  .why { font-style: italic; color: var(--vscode-descriptionForeground); margin-bottom: 4px; font-size: 11px; }
  .meta { display: flex; gap: 6px; align-items: center; }
  .badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; }
  .badge-active { background: var(--vscode-testing-iconPassed); color: #fff; }
  .badge-inferred { background: var(--vscode-charts-blue); color: #fff; }
  .type { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 16px 0; text-align: center; }
  .link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline; }
</style>
</head>
<body>
  <div class="scope" id="scope-label">Connecting…</div>
  <div id="beliefs-list"></div>
  <div id="record-panel" style="display:none">
    <div style="border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:8px;">
      <div style="font-size:11px;font-weight:600;margin-bottom:8px;">Record Belief</div>
      <div style="margin-bottom:6px;">
        <select id="r-type" style="width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:4px;">
          <option value="decision">Decision</option>
          <option value="preference">Preference</option>
          <option value="entity">Entity</option>
          <option value="relation">Relation</option>
        </select>
      </div>
      <div style="margin-bottom:6px;">
        <textarea id="r-content" placeholder="What should Tenure remember?" rows="3"
          style="width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:4px;resize:vertical;box-sizing:border-box;"></textarea>
      </div>
      <div style="margin-bottom:8px;">
        <input id="r-why" type="text" placeholder="Why does this matter?"
          style="width:100%;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:4px;box-sizing:border-box;">
      </div>
      <div id="r-error" style="color:var(--vscode-errorForeground);font-size:10px;margin-bottom:4px;display:none"></div>
      <div style="display:flex;gap:4px;justify-content:flex-end;">
        <button onclick="closeForm()" style="background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);font-family:inherit;font-size:11px;padding:3px 8px;cursor:pointer;border-radius:3px;">Cancel</button>
        <button onclick="submitForm()" style="background:var(--vscode-button-background);border:none;color:var(--vscode-button-foreground);font-family:inherit;font-size:11px;padding:3px 8px;cursor:pointer;border-radius:3px;">Record</button>
      </div>
    </div>
  </div>
  <div style="border-top:1px solid var(--vscode-panel-border);margin-top:8px;padding-top:8px;">
    <button onclick="openForm()" id="open-form-btn"
      style="width:100%;background:var(--vscode-button-secondaryBackground);border:none;color:var(--vscode-button-secondaryForeground);font-family:inherit;font-size:11px;padding:5px;cursor:pointer;border-radius:3px;">
      + Record Belief
    </button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();

    function post(cmd, data) {
      vscode.postMessage({ command: cmd, ...data });
    }

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function renderBeliefs(scope, beliefs) {
      document.getElementById("scope-label").textContent = scope;

      const list = document.getElementById("beliefs-list");

      if (beliefs.length === 0) {
        list.innerHTML =
          '<div class="empty">No beliefs for this scope yet.' +
          '<br><span class="link" onclick="post(\\'openDashboard\\')">Open Dashboard</span></div>';
        return;
      }

      const emptyEl = list.querySelector(".empty");
      if (emptyEl) emptyEl.remove();

      const incomingIds = new Set(beliefs.map(b => b.id));

      list.querySelectorAll("[data-belief-id]").forEach(el => {
        if (!incomingIds.has(el.dataset.beliefId)) el.remove();
      });

      beliefs.forEach((b, i) => {
        const existing = list.querySelector('[data-belief-id="' + b.id + '"]');
        const html = beliefHtml(b);

        if (existing) {
   
          if (existing.dataset.hash !== hashBelief(b)) {
            existing.outerHTML = html;
          }
        } else {
          const ref = list.children[i] ?? null;
          const tmp = document.createElement("div");
          tmp.innerHTML = html;
          const node = tmp.firstElementChild;
          list.insertBefore(node, ref);
        }
      });
    }

    function hashBelief(b) {
      return b.id + b.content + b.pinned + b.epistemic_status + b.canonical_name;
    }

    function beliefHtml(b) {
      return (
        '<div class="belief ' + (b.pinned ? "pinned" : "") +
        '" data-belief-id="' + esc(b.id) +
        '" data-hash="' + esc(hashBelief(b)) + '">' +
          '<div class="belief-header">' +
            '<div class="name">' + esc(b.canonical_name) + "</div>" +
            '<button class="pin-btn" ' +
              'onclick="post(\\'pinBelief\\', {id:\\'' + esc(b.id) + '\\',pinned:' + b.pinned + '})" ' +
              'title="' + (b.pinned ? "Unpin" : "Pin") + '">' +
              (b.pinned ? "★" : "☆") +
            "</button>" +
          "</div>" +
          '<div class="content">' + esc(b.content) + "</div>" +
          (b.why_it_matters
            ? '<div class="why">' + esc(b.why_it_matters) + "</div>"
            : "") +
          '<div class="meta">' +
            '<span class="badge badge-' + esc(b.epistemic_status) + '">' +
              esc(b.epistemic_status) +
            "</span>" +
            '<span class="type">' + esc(b.type) + "</span>" +
          "</div>" +
        "</div>"
      );
    }

    function openForm() {
      document.getElementById("record-panel").style.display = "block";
      document.getElementById("open-form-btn").style.display = "none";
      document.getElementById("r-content").focus();
    }

    function closeForm() {
      document.getElementById("record-panel").style.display = "none";
      document.getElementById("open-form-btn").style.display = "block";
      document.getElementById("r-content").value = "";
      document.getElementById("r-why").value = "";
      document.getElementById("r-error").style.display = "none";
    }

    function submitForm() {
      const type = document.getElementById("r-type").value;
      const content = document.getElementById("r-content").value.trim();
      const why = document.getElementById("r-why").value.trim();
      const errEl = document.getElementById("r-error");

      if (!content) {
        errEl.textContent = "Content is required.";
        errEl.style.display = "block";
        return;
      }
      if (!why) {
        errEl.textContent = "Why it matters is required.";
        errEl.style.display = "block";
        return;
      }

      errEl.style.display = "none";
      post("recordBelief", { beliefType: type, content, why });
      closeForm();
    }

    function renderEmpty(label, line1, line2) {
      document.getElementById("scope-label").textContent = label;
      document.getElementById("beliefs-list").innerHTML =
        '<div class="empty">' + line1 +
        (line2 ? '<br><span style="font-size:10px;opacity:0.7;">' + line2 + '</span>' : '') +
        '</div>';
    }

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "state":
          renderBeliefs(data.scope, data.beliefs);
          break;
        case "no_workspace":
          renderEmpty("No workspace open", "Open a folder to start", "Tenure tracks beliefs per project");
          break;
        case "disconnected":
          renderEmpty("Not connected", "Tenure proxy is unreachable", "Check that your local proxy is running");
          break;
        case "error":
          console.warn("[Tenure WS] server error on " + data.request_type + ": " + data.message);
          break;
        case "open_form":
          openForm();
          break;
      }
    });


    post("ready");
  </script>
</body>
</html>`;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }
}

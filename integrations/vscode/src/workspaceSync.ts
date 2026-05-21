import * as vscode from "vscode";
import { resolveGitRemote } from "./gitResolver.js";
import type { TokenStore } from "./tokenStore.js";
import { readTenureConfig } from "./tenureConfig.js";
import { TenureBeliefsViewProvider } from "./beliefsViewProvider.js";
import path, { basename } from "node:path";
import { createHash } from "node:crypto";

export interface WorkspaceState {
  workspace_root: string;
  project_name: string;
  git_remote: string | null;
  active_file: string | null;
  active_language: string | null;
}

export class WorkspaceSync {
  private lastSyncedState: string | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  private cachedProjectName: string | null = null;
  private cachedGitRemote: string | null = null;
  private workspaceResolved = false;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly context: vscode.ExtensionContext,
    private readonly statusBar?: vscode.StatusBarItem,
    private readonly beliefsProvider?: TenureBeliefsViewProvider,
  ) {
    this.lastSyncedState =
      this.context.workspaceState.get<string>("tenure.lastSyncedState") ?? null;

    this.beliefsProvider?.setOnConnectedCallback(() => {
      this.invalidateCache();
      this.scheduleSync();
    });
  }

  scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), 300);
  }

  invalidateCache(): void {
    this.lastSyncedState = null;
    this.workspaceResolved = false;
    this.cachedProjectName = null;
    this.cachedGitRemote = null;
    void this.context.workspaceState.update(
      "tenure.lastSyncedState",
      undefined,
    );
  }

  invalidateManifestCache(): void {
    this.workspaceResolved = false;
    this.cachedProjectName = null;
  }

  getLastProjectName(): string | null {
    return this.cachedProjectName ?? null;
  }

  reconnectBeliefs(): void {
    this.beliefsProvider?.reconnect().catch(() => {});
  }

  sendActiveFileUpdate(
    activeFile: string,
    activeLanguage: string,
    fileUri: vscode.Uri,
  ): void {
    if (!this.beliefsProvider || !this.cachedProjectName) return;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    this.beliefsProvider.sendWorkspaceState({
      workspace_root: workspaceFolder.uri.fsPath,
      project_name: this.cachedProjectName,
      git_remote: this.cachedGitRemote,
      active_file: activeFile,
      active_language: activeLanguage,
    });

    vscode.workspace.fs.stat(fileUri).then((stat) => {
      this.beliefsProvider?.sendFileMeta(activeFile, stat.size);
    });
  }

  async sync(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("tenure");
    if (!cfg.get<boolean>("enabled", true)) return;

    if (!vscode.workspace.isTrusted) {
      if (this.statusBar) {
        this.statusBar.text = "$(symbol-misc) Tenure: Restricted";
        this.statusBar.tooltip =
          "Workspace not trusted. File-based scope resolution disabled.";
      }
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return;

    const token = await this.tokenStore.get();
    if (!token) {
      if (this.statusBar) {
        this.statusBar.text = "$(warning) Tenure: Token Missing";
        this.statusBar.command = "tenure.setToken";
      }
      return;
    }

    if (!this.workspaceResolved) {
      await this.resolveWorkspaceLevel(workspaceFolder.uri);
    }

    const activeEditor = vscode.window.activeTextEditor;
    const activeFileUri = activeEditor?.document.uri ?? null;
    const activeFile = activeFileUri ? toRelativeFile(activeFileUri) : null;
    const activeLanguage = activeEditor?.document.languageId ?? null;

    const state: WorkspaceState = {
      workspace_root: workspaceFolder.uri.fsPath,
      project_name: this.cachedProjectName!,
      git_remote: this.cachedGitRemote,
      active_file: activeFile,
      active_language: activeLanguage,
    };

    const stateKey = JSON.stringify(state);
    if (stateKey === this.lastSyncedState) return;

    const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");

    if (this.lastSyncedState) {
      const previousState = JSON.parse(this.lastSyncedState) as WorkspaceState;
      if (previousState.project_name !== state.project_name) {
        this.migrateScope(
          previousState.project_name,
          state.project_name,
          token,
          baseUrl,
        ).catch(() => {});
      }
    }

    this.lastSyncedState = stateKey;
    await this.context.workspaceState.update(
      "tenure.lastSyncedState",
      stateKey,
    );

    if (this.statusBar) {
      this.statusBar.text = `$(symbol-misc) Tenure: ${this.cachedProjectName}`;
      this.statusBar.command = "tenure.openBeliefs";
    }

    if (this.beliefsProvider) {
      await this.beliefsProvider.ensureConnected();
      this.beliefsProvider.sendWorkspaceState(state);
    }
  }

  dispose(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
  }

  private async resolveWorkspaceLevel(rootUri: vscode.Uri): Promise<void> {
    const tenureConfig = await readTenureConfig(rootUri);
    const gitRemote = resolveGitRemote(rootUri);
    const gitName = gitRemote ? extractRepoName(gitRemote) : null;

    this.cachedGitRemote = gitRemote;
    this.cachedProjectName =
      tenureConfig?.projectId ??
      gitName ??
      getLocalFallbackSlug(rootUri.fsPath);

    this.workspaceResolved = true;
  }

  private async migrateScope(
    oldName: string,
    newName: string,
    token: string,
    baseUrl: string,
  ): Promise<void> {
    await fetch(`${baseUrl}/v1/workspace/migrate-scope`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        old_scope: `project:${slugify(oldName)}`,
        new_scope: `project:${slugify(newName)}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  }
}

function extractRepoName(remoteUrl: string): string | null {
  const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function toRelativeFile(fileUri: vscode.Uri): string | null {
  // 1. Pass 'true' to exclude the workspace folder name in multi-root setups.
  // This ensures a file in 'src/main.js' always returns 'src/main.js'.
  const relative = vscode.workspace.asRelativePath(fileUri, true);

  // 2. VS Code returns a path with forward slashes. On Windows, path.isAbsolute()
  // handles forward slashes perfectly fine to determine if it's an absolute fallback.
  if (path.isAbsolute(relative)) {
    return null; // File is outside any open workspace folder
  }

  return relative;
}

function getLocalFallbackSlug(workspaceRoot: string): string {
  const folderName = basename(workspaceRoot);
  const hash = createHash("md5")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 8);
  return `${folderName}-${hash}`;
}

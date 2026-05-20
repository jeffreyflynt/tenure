import * as vscode from "vscode";
import {
  getLocalFallbackSlug,
  resolveNearestPackageName,
} from "./packageResolver.js";
import { resolveGitRemote } from "./gitResolver.js";
import type { TokenStore } from "./tokenStore.js";
import { readTenureConfig } from "./tenureConfig.js";

export interface WorkspaceState {
  workspace_root: string;
  project_name: string;
  git_remote: string | null;
  active_file: string | null;
  active_language: string | null;
}

export class WorkspaceSync {
  private lastSyncedState: string | null = null;

  private loadPersistedState(): void {
    this.lastSyncedState =
      this.context.workspaceState.get<string>("tenure.lastSyncedState") ?? null;
  }
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly tokenStore: TokenStore,
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext,
    private readonly statusBar?: vscode.StatusBarItem,
  ) {
    this.lastSyncedState =
      this.context.workspaceState.get<string>("tenure.lastSyncedState") ?? null;
  }

  /**
   * Debounced sync. Coalesces rapid editor switches (e.g. opening a file)
   * into a single request 300ms after the last event fires.
   */
  scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => this.sync(), 300);
  }

  invalidateCache(): void {
    this.lastSyncedState = null;
    void this.context.workspaceState.update(
      "tenure.lastSyncedState",
      undefined,
    );
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

    const activeEditor = vscode.window.activeTextEditor;

    const activeFileUri = activeEditor?.document.uri ?? null;
    const workspaceRootUri = workspaceFolder.uri;

    const tenureConfig = await readTenureConfig(workspaceRootUri);
    const packageName = await resolveNearestPackageName(
      activeFileUri ?? undefined,
      workspaceRootUri,
    );
    const gitRemote = resolveGitRemote(workspaceRootUri);
    const gitName = gitRemote ? extractRepoName(gitRemote) : null;

    const projectName =
      tenureConfig?.projectId ??
      packageName ??
      gitName ??
      getLocalFallbackSlug(workspaceRootUri.fsPath);

    const state: WorkspaceState = {
      workspace_root: workspaceRootUri.fsPath,
      project_name: projectName,
      git_remote: gitRemote,
      active_file: activeFileUri?.fsPath ?? null,
      active_language: activeEditor?.document.languageId ?? null,
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

    try {
      const res = await fetch(`${baseUrl}/v1/workspace/state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-tenure-ide": "1",
        },
        body: JSON.stringify(state),
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        this.lastSyncedState = stateKey;
        await this.context.workspaceState.update(
          "tenure.lastSyncedState",
          stateKey,
        );
        if (this.statusBar) {
          this.statusBar.text = `$(symbol-misc) Tenure: ${projectName}`;
          this.statusBar.command = "tenure.openBeliefs";
        }
      } else {
        this.output.appendLine(
          `[Tenure] Workspace sync failed: ${res.status} ${res.statusText}`,
        );
      }
    } catch {
      // Tenure not running or unreachable — fail silently
    }
  }

  dispose(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
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

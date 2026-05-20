import * as vscode from "vscode";

interface GitExtension {
  getAPI(version: number): any;
}

/**
 * Resolves the git remote origin URL for a given workspace directory natively
 * using VS Code's internal Git extension.
 */
export function resolveGitRemote(workspaceRootUri: vscode.Uri): string | null {
  try {
    const gitExtension =
      vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
    if (!gitExtension) {
      return null;
    }

    const gitAPI = gitExtension.getAPI(1);

    const repository = gitAPI.getRepository(workspaceRootUri);
    if (!repository) {
      return null;
    }

    const remotes = repository.state.remotes || [];
    const originRemote = remotes.find(
      (remote: any) => remote.name === "origin",
    );

    return originRemote?.fetchUrl || originRemote?.pushUrl || null;
  } catch {
    return null;
  }
}

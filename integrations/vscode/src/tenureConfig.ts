import * as vscode from "vscode";

export interface TenureProjectConfig {
  projectId?: string;
}

export async function readTenureConfig(
  workspaceRootUri: vscode.Uri,
): Promise<TenureProjectConfig | null> {
  const candidates = [
    vscode.Uri.joinPath(workspaceRootUri, ".tenure"),
    vscode.Uri.joinPath(workspaceRootUri, ".tenure", "config.json"),
  ];

  for (const candidate of candidates) {
    try {
      const rawContent = await vscode.workspace.fs.readFile(candidate);
      return JSON.parse(
        new TextDecoder().decode(rawContent),
      ) as TenureProjectConfig;
    } catch {
      // file missing or malformed, try next
    }
  }

  return null;
}

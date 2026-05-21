import * as vscode from "vscode";

export async function readTenureConfig(
  workspaceRootUri: vscode.Uri,
): Promise<{ projectId: string } | null> {
  const fileUri = vscode.Uri.joinPath(workspaceRootUri, ".tenure");
  try {
    const rawContent = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(rawContent).trim();

    return text ? { projectId: text } : null;
  } catch {
    return null;
  }
}

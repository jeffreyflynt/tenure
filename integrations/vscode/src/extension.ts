import * as vscode from "vscode";
import { TokenStore } from "./tokenStore.js";
import { WorkspaceSync } from "./workspaceSync.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) return;

  const output = vscode.window.createOutputChannel("Tenure", { log: true });
  const tokenStore = new TokenStore(context.secrets);

  const existingToken = await tokenStore.get();
  await vscode.commands.executeCommand(
    "setContext",
    "tenure.tokenConfigured",
    existingToken !== undefined,
  );

  if (!existingToken) {
    await maybeShowTokenWarning(context);
  }

  const statusBar = vscode.window.createStatusBarItem(
    "tenure.status",
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "tenure.openBeliefs";
  statusBar.text = "$(symbol-misc) Tenure";
  statusBar.tooltip = "Click to open your Beliefs Dashboard";
  statusBar.show();

  const sync = new WorkspaceSync(tokenStore, output, context, statusBar);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const manifestWatcher = workspaceFolder
    ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          workspaceFolder,
          "**/{package.json,Cargo.toml,go.mod,pyproject.toml,setup.py,pom.xml,settings.gradle,settings.gradle.kts,.tenure}",
        ),
      )
    : null;

  context.subscriptions.push(
    vscode.commands.registerCommand("tenure.setToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Paste your Tenure API token",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "mp_...",
      });
      if (token?.trim()) {
        await tokenStore.set(token.trim());
        vscode.window.showInformationMessage("Tenure: token saved.");
        sync.scheduleSync();
      }
    }),

    vscode.commands.registerCommand("tenure.syncNow", () => {
      sync.scheduleSync();
      vscode.window.showInformationMessage("Tenure: workspace sync triggered.");
    }),

    vscode.commands.registerCommand("tenure.openBeliefs", () => {
      const cfg = vscode.workspace.getConfiguration("tenure");
      const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");
      vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/beliefs`));
    }),

    vscode.window.onDidChangeActiveTextEditor(() => sync.scheduleSync()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sync.scheduleSync()),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("tenure.enabled")) {
        const isEnabled = vscode.workspace
          .getConfiguration("tenure")
          .get<boolean>("enabled", true);
        if (!isEnabled) {
          sync.dispose();
          statusBar.text = "$(circle-slash) Tenure: Disabled";
          statusBar.command = undefined;
        } else {
          sync.scheduleSync();
          statusBar.command = "tenure.openBeliefs";
        }
      }

      if (event.affectsConfiguration("tenure.baseUrl")) {
        // Base URL changed — invalidate cache so next sync pushes to new URL
        // even if workspace state is otherwise unchanged
        sync.invalidateCache();
        sync.scheduleSync();
      }
    }),
    ...(manifestWatcher
      ? [
          manifestWatcher.onDidChange(() => sync.scheduleSync()),
          manifestWatcher.onDidCreate(() => sync.scheduleSync()),
          manifestWatcher.onDidDelete(() => sync.scheduleSync()),
          manifestWatcher,
        ]
      : []),

    statusBar,
    output,
    { dispose: () => sync.dispose() },
  );

  sync.scheduleSync();
}

export function deactivate(): void {
  // cleanup handled via context.subscriptions
}

const DONT_SHOW_TOKEN_WARNING = "tenure.dontShowTokenWarning";

async function maybeShowTokenWarning(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (context.globalState.get<boolean>(DONT_SHOW_TOKEN_WARNING)) return;

  const action = await vscode.window.showWarningMessage(
    "Tenure: No API token configured. Tenure will not sync workspace state.",
    "Set Token",
    "Don't show again",
  );

  if (action === "Set Token") {
    vscode.commands.executeCommand("tenure.setToken");
  } else if (action === "Don't show again") {
    await context.globalState.update(DONT_SHOW_TOKEN_WARNING, true);
  }
}

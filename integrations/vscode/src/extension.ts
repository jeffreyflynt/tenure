import * as vscode from "vscode";
import { TokenStore } from "./tokenStore.js";
import { WorkspaceSync } from "./workspaceSync.js";
import { TenureBeliefsViewProvider } from "./beliefsViewProvider.js";
import path from "node:path";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const tokenStore = new TokenStore(context.secrets);

  const existingToken = await tokenStore.get();
  await vscode.commands.executeCommand(
    "setContext",
    "tenure.tokenConfigured",
    existingToken !== undefined,
  );

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
        await vscode.commands.executeCommand(
          "setContext",
          "tenure.tokenConfigured",
          true,
        );
        vscode.window.showInformationMessage("Tenure: token saved.");
        sync?.scheduleSync();
      }
    }),

    vscode.commands.registerCommand("tenure.openBeliefs", () => {
      const cfg = vscode.workspace.getConfiguration("tenure");
      const baseUrl = cfg.get<string>("baseUrl", "http://localhost:5757");
      vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/beliefs`));
    }),
  );

  if (!existingToken) {
    await maybeShowTokenWarning(context);
  }

  if (!vscode.workspace.workspaceFolders?.length) {
    const noWorkspaceProvider = new TenureBeliefsViewProvider(
      tokenStore,
      context.extensionUri,
    );
    noWorkspaceProvider.setNoWorkspace(true);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "tenure.beliefsView",
        noWorkspaceProvider,
      ),
    );
    return;
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

  const beliefsProvider = new TenureBeliefsViewProvider(
    tokenStore,
    context.extensionUri,
  );
  const sync = new WorkspaceSync(
    tokenStore,
    context,
    statusBar,
    beliefsProvider,
  );

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const tenureWatcher = workspaceFolder
    ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceFolder, ".tenure"),
      )
    : null;

  if (tenureWatcher) {
    const handleConfigMutation = () => {
      sync.invalidateCache();
      sync.scheduleSync();
    };

    context.subscriptions.push(
      tenureWatcher.onDidChange(handleConfigMutation),
      tenureWatcher.onDidCreate(handleConfigMutation),
      tenureWatcher.onDidDelete(handleConfigMutation),
      tenureWatcher,
    );
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "tenure.beliefsView",
      beliefsProvider,
    ),

    vscode.commands.registerCommand("tenure.syncNow", () => {
      sync.scheduleSync();
      vscode.window.showInformationMessage("Tenure: workspace sync triggered.");
    }),

    vscode.commands.registerCommand("tenure.recordBelief", async () => {
      const token = await tokenStore.get();
      if (!token) {
        vscode.window.showWarningMessage("Tenure: No token configured.");
        return;
      }
      vscode.commands.executeCommand("tenure.beliefsView.focus");
      beliefsProvider.openRecordForm();
    }),

    vscode.commands.registerCommand(
      "tenure.recordBeliefFromSelection",
      async () => {
        const token = await tokenStore.get();
        if (!token) {
          vscode.window.showWarningMessage("Tenure: No token configured.");
          return;
        }
        vscode.commands.executeCommand("tenure.beliefsView.focus");
        beliefsProvider.openRecordForm();
      },
    ),

    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        const oldPath = vscode.workspace.asRelativePath(oldUri, true);
        const newPath = vscode.workspace.asRelativePath(newUri, true);

        if (path.isAbsolute(oldPath) || path.isAbsolute(newPath)) continue;

        beliefsProvider.sendRenameFile(oldPath, newPath);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.uri) {
        const relativePath = vscode.workspace.asRelativePath(
          editor.document.uri,
          true,
        );
        const projectName = sync.getLastProjectName();
        if (projectName && !path.isAbsolute(relativePath)) {
          const scope = `project:${slugify(projectName)}`;
          beliefsProvider.sendFetchFileBeliefs(
            relativePath,
            scope,
            editor.document.uri,
          );
          sync.sendActiveFileUpdate(
            relativePath,
            editor.document.languageId,
            editor.document.uri,
          );
        }
      }
    }),

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
        sync.invalidateCache();
        sync.reconnectBeliefs();
        sync.scheduleSync();
      }
    }),

    statusBar,
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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

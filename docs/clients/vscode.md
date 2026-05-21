# VS Code

The Tenure VS Code extension syncs your workspace context to the Tenure proxy on every file switch. This tells Tenure which project you're working in before your first message is sent, so scope resolution is instant and accurate rather than inferred from the conversation.

The extension works with any AI client inside VS Code that you can point at a custom base URL: Cline, Continue, Windsurf, Cursor, and others. See the individual client pages for client-specific setup.

> **This extension requires Tenure to be running locally.** It has no standalone value without it. See the [quickstart](../quickstart.md) to get Tenure running before installing this extension.

## Requirements

- Tenure running locally. See [quickstart.md](../quickstart.md) if you haven't installed it yet.
- VS Code 1.80 or later.
- A workspace folder open. The extension does not activate in single-file mode.

## Installation

Install from the VS Code Marketplace:

```
ext install tenureai.tenure
```

Or search for **Tenure** in the Extensions panel.

## Adding your token

The extension needs your Tenure bearer token to sync workspace state.

1. Open the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **Tenure: Set API Token**
3. Paste your token (found in `~/.tenure/token` on Linux/macOS or `%USERPROFILE%\.tenure\token` on Windows)

The token is stored in VS Code's secret storage. You only need to do this once.

If no token is configured, the extension shows a warning on startup and the status bar displays **Tenure: Token Missing**. Clicking it opens the token prompt.

## Pointing your AI client at Tenure

Once the token is set, point whichever AI client you use in VS Code at Tenure's proxy:

```
http://localhost:5757/v1
```

The extension handles scope -- your AI client just needs to route through Tenure. See the individual client pages for where to set the base URL in each tool.

## Project scope

Tenure resolves your project name from a `.tenure` file at your workspace root.
Create one with just your project name:

f no .tenure file exists, Tenure falls back to your git remote name, then
a stable slug derived from your workspace folder name. Scope resolution never
fails silently.

Run `Tenure: Create .tenure File` from the command palette to scaffold one
automatically using the name Tenure has already resolved for your project.

## Overriding scope manually

If the automatic resolution picks up the wrong project name, you can override it with a `.tenure` file in your workspace root:

```
my-project
```

This takes priority over all manifest-based resolution.

You can also set scope directly from your chat session:

```
!scope project:my-project
```

## Status bar

The status bar item in the bottom-right shows the current sync state:

| Status                  | Meaning                                          |
| ----------------------- | ------------------------------------------------ |
| `Tenure: my-project`    | Synced, showing resolved project name            |
| `Tenure: Token Missing` | No token configured, click to set one            |
| `Tenure: Restricted`    | Workspace not trusted, file-based scope disabled |
| `Tenure: Disabled`      | Extension disabled in settings                   |

Clicking the status bar item when synced opens your Beliefs Dashboard at `http://localhost:5757/beliefs`.

## Commands

| Command                                | Description                                       |
| -------------------------------------- | ------------------------------------------------- |
| `Tenure: Set API Token`                | Store your Tenure bearer token                    |
| `Tenure: Sync Workspace State`         | Trigger a manual sync                             |
| `Tenure: Open Beliefs Dashboard`       | Open `localhost:5757/beliefs` in your browser     |
| `Tenure: Record Project Belief`        | Record a belief directly from the command palette |
| `Tenure: Record Belief from Selection` | Record a belief from selected code                |
| `Tenure: Create .tenure File`          | Scaffold a .tenure file with your resolved name   |

## Settings

| Setting          | Default                 | Description                     |
| ---------------- | ----------------------- | ------------------------------- |
| `tenure.baseUrl` | `http://localhost:5757` | URL of your local Tenure proxy  |
| `tenure.enabled` | `true`                  | Enable or disable the extension |

## Docker networking

If Tenure is running in Docker and your VS Code is on the host machine, the default `localhost:5757` should work. If you're running into connection issues, check that the Tenure container is binding to `0.0.0.0` rather than `127.0.0.1`.

## Troubleshooting

**Status bar shows "Token Missing" after setting the token**
Run **Tenure: Sync Workspace State** from the command palette to force a sync.

**Project name is wrong**
Add a `.tenure` file to your workspace root containing your project name,
or run **Tenure: Create .tenure File** to scaffold one automatically.
The file takes priority over all other resolution methods.

**Extension isn't activating**
The extension requires a workspace folder to be open. It will not activate in single-file mode or when no folder is loaded.

**Sync fails silently**
If Tenure isn't running, the extension fails silently rather than showing errors. Confirm Tenure is running and reachable at `http://localhost:5757`.

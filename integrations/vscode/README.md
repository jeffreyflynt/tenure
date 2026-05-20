# Tenure for VS Code

Persistent, cross-application AI memory. Connects your tools, agents, and interfaces with a shared, evolving understanding. Fully local and private.

## The workflow this unlocks

You spend an hour in OpenWebUI thinking through an architecture problem. You explore options, rule some out, land on a direction. Then you open VS Code to start building.

Tenure is already there. It knows what you decided, what you rejected, and why. You don't re-explain anything. You just build.

This works today. OpenWebUI, LibreChat, and any OpenAI-compatible chat client connect to Tenure by pointing at `localhost:5757/v1`. The VS Code extension is the piece that brings your IDE into the same workflow, so the thinking you do in one place is already present when you switch to another.

## The problem it also solves

Beyond cross-interface continuity, Tenure fixes the way AI coding sessions break in practice, not dramatically, but through drift. A script gets renamed in `package.json`. A config file moves. A rule you wrote for Cline never makes it into the equivalent for Windsurf. The agent doesn't know any of this. It works from whatever it was last told, and what it was last told is increasingly wrong.

The deeper issue is duplication. Anything that copies information already in your code or config will go stale. Anything that just points to that information tends to stay correct. Most `AGENTS.md` files are full of copies.

Tenure doesn't duplicate. It learns.

## What this extension does

On every file switch, it pushes your current workspace context: project name, active file, language, to Tenure so the proxy resolves the right project scope before your first message is sent.

Without the extension, Tenure still works, it resolves scope from the first message. The extension makes it instant and accurate, especially across monorepos where the root name and the active package are different things.

## Don't have Tenure installed?

The recommended install runs in a docker container the only thing it can touch on your machine is `~/.tenure`.

**macOS / Linux:**

```bash
docker run --rm -v "$HOME/.tenure:/app/.tenure" tenureai/tenure:latest init
docker run -d -v "$HOME/.tenure:/app/.tenure" -p 5757:5757 tenureai/tenure:latest
```

**Windows (PowerShell):**

```powershell
docker run --rm -v "$env:USERPROFILE\.tenure:/app/.tenure" tenureai/tenure:latest init
docker run -d -v "$env:USERPROFILE\.tenure:/app/.tenure" -p 5757:5757 tenureai/tenure:latest
```

Your API token is saved to `~/.tenure/token` after the first command.

Prefer a one-liner? The shell scripts are still available,
see the [quickstart](https://github.com/tenurehq/tenure#quick-start).

## Setup

1. Install this extension
2. Run **Tenure: Set API Token** from the command palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Paste your token from `~/.tenure/token`
4. Point your AI client's base URL at `http://localhost:5757/v1`

That's it. The extension syncs automatically on every file switch.

## Which clients work with Tenure?

Tenure works with any client where you control the base URL. That includes OpenWebUI, Cline, Continue, Windsurf, and any OpenAI-compatible chat interface. Point them at `localhost:5757/v1` and they route through Tenure automatically.

Cursor Pro and the Claude Code VS Code extension route through their own backends by default. Claude Code can be configured to route through an external proxy using claudeCode.disableLoginPrompt: true.

## Commands

| Command                          | Description                                   |
| -------------------------------- | --------------------------------------------- |
| `Tenure: Set API Token`          | Store your Tenure token securely              |
| `Tenure: Sync Workspace State`   | Manually trigger a sync                       |
| `Tenure: Open Beliefs Dashboard` | Open `localhost:5757/beliefs` in your browser |

## Settings

| Setting          | Default                 | Description                     |
| ---------------- | ----------------------- | ------------------------------- |
| `tenure.baseUrl` | `http://localhost:5757` | URL of your local Tenure proxy  |
| `tenure.enabled` | `true`                  | Enable or disable the extension |

## Monorepo and multi-language support

The extension walks upward from your active file looking for the nearest
project manifest — `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`,
`setup.py`, `pom.xml`, `settings.gradle`, `.sln`, or `.csproj`. Whichever
it finds first becomes the project scope sent to Tenure.

In a monorepo with `packages/proxy/src/foo.ts` open, it resolves `proxy`,
not the root workspace name. Switch to a file in `packages/auth` and scope
switches with you. Beliefs are always attributed to the right package
regardless of where you are in the tree.

If no manifest is found, the extension falls back to a stable slug derived
from your workspace folder name so scope resolution never fails silently.

## Why not just use AGENTS.md or shared MCP memory?

`AGENTS.md` works until it drifts. The most common failure mode is stale paths, renamed scripts, and instructions nobody updated after a refactor. The file becomes a liability the more it tries to duplicate what's already in your config.

Shared MCP memory across tools is mostly experimental. Memory one tool writes and another reads only works if both are disciplined about when to write and when to retrieve. In practice that coordination is not there yet.

Tenure runs locally, outside any single tool, and uses a proxy layer that all your clients route through. The memory is written once and applied everywhere, without requiring each tool to implement the same retrieval discipline.

## Learn more

- [Quickstart](https://github.com/tenurehq/tenure#quick-start)
- [How beliefs work](https://github.com/tenurehq/tenure/blob/main/docs/beliefs.md)
- [Retrieval and scoping](https://github.com/tenurehq/tenure/blob/main/docs/retrieval.md)
- [Research paper](https://arxiv.org/abs/2605.11325)

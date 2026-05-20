# Tenure for OpenClaw

Persistent memory for your OpenClaw assistant. Tenure remembers your decisions, preferences, and working style across every session, so you never have to re-explain your stack, your voice, or what you ruled out last week.

## What it does

Every new session normally starts from zero. You re-explain that you use TypeScript, hate ORMs, prefer explicit error returns. Tenure fixes that.

It sits between OpenClaw and your AI provider and quietly learns from your conversations. Your tools, your opinions, what you've decided and why — all of it carries forward automatically. By your tenth session it feels like working with someone who actually knows you.

- **Remembers what you chose and what you rejected.** Ask about Mongoose and Tenure surfaces your MongoDB raw driver decision, because what you ruled out is just as important as what you picked.
- **Learns how to talk to you.** Not just facts, but whether you want a direct answer or to think out loud, whether you read long responses or skim them.
- **Stays local.** Everything runs on your machine. Your context never leaves `localhost`.
- **Works across every model switch.** Switch models mid-session and Tenure stays in the path automatically, with no extra steps required.
- **Isolates work, personal, and side projects.** Create different OpenClaw agents for different areas of your life. Tenure detects which agent you are talking to and partitions your memory automatically, keeping your corporate workflows completely separate from your personal hobbies.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [Docker](https://www.docker.com/get-started/) installed and running
- An Anthropic or OpenAI API key for Tenure's extraction

## Installation

The easiest way is through OpenClaw's chat interface. Just say:

> "Install Tenure"

OpenClaw will walk you through the full setup using the bundled skill.

## Manual installation

If you prefer to install the plugin directly:

```bash
openclaw plugins install tenure-openclaw-plugin
openclaw gateway restart
```

Then run `!tenure onboarding` in any chat session to connect your provider and build your initial memory profile.

## Usage

Once installed, Tenure works automatically in the background. You don't need to do anything differently.

A few commands you can use from any chat session:

| Command              | What it does                                  |
| -------------------- | --------------------------------------------- |
| `!tenure`            | Check if Tenure is running                    |
| `!tenure onboarding` | Set up or reconfigure your provider and model |
| `!extract off`       | Pause memory recording for this session       |
| `!extract on`        | Resume memory recording                       |
| `!inject off`        | Turn off memory context for this session      |
| `!scope domain:code` | Set the scope for this session manually       |

View and edit your memory at [http://localhost:5757/beliefs](http://localhost:5757/beliefs).

## Agent and Context Isolation

If you use multiple OpenClaw agents, keeping their memories separate is not just a convenience — it is a core guarantee Tenure is built around.

Many users rely on distinct agents for meaningfully different areas of their lives: a work agent that knows your codebase conventions, a finance agent that tracks your budget decisions, a personal agent that knows your writing voice. Mixing context across these agents would undermine the whole point of having them. Tenure treats isolation as a first-class feature, not an afterthought.

Tenure features native support for OpenClaw's multi-agent architecture. You do not need to manually configure separate databases or workspaces. When you chat with a specific agent, the plugin automatically detects its unique identifier and loads only the memory that belongs to it.

- **Automatic siloing:** Memories captured while talking to your Finance Agent will never appear in sessions with your Creative Writing Agent, and vice versa.
- **Global vs. local scopes:** Universal communication habits, like your preference for concise bullet points, adapt gracefully across your entire profile. Everything else stays agent-specific.
- **No configuration required:** Isolation is on by default. You do not need to opt in or set anything up.

If you ever need to manually override a session's focus, use the `!scope` command:

```
!scope domain:parenting
```

## Removing Tenure

Say "Remove Tenure" in any OpenClaw chat session. The skill will walk you through a clean removal including all data.

## Privacy

Tenure runs entirely on your machine. Your beliefs, preferences, and conversation history never leave `localhost`. The only outbound traffic is to your configured AI provider (Anthropic or OpenAI) for belief extraction, the same provider OpenClaw already uses.

## More information

- [Tenure on GitHub](https://github.com/tenurehq/tenure)
- [How retrieval works](https://github.com/tenurehq/tenure/blob/main/docs/retrieval.md)
- [Security details](https://github.com/tenurehq/tenure/blob/main/docs/security.md)

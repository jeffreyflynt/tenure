# OpenClaw

Tenure is available as a native plugin for OpenClaw, with automatic per-agent memory isolation built in.

Available on [ClawHub](https://clawhub.ai/plugins/@tenureai/openclaw-plugin) and [npm](https://www.npmjs.com/package/@tenureai/openclaw-plugin).

## Installation

The easiest way is through OpenClaw's chat interface. Just say:

> "Install Tenure"

OpenClaw will walk you through the full setup using the bundled skill.

### Manual installation

```bash
openclaw plugins install clawhub:@tenureai/openclaw-plugin
openclaw gateway restart
```

Then run `!tenure onboarding` in any chat session to connect your provider and build your initial memory profile.

## Usage

Once installed, Tenure works automatically. You don't need to do anything differently.

| Command              | What it does                                  |
| -------------------- | --------------------------------------------- |
| `!tenure`            | Check if Tenure is running                    |
| `!tenure onboarding` | Set up or reconfigure your provider and model |
| `!extract off`       | Pause memory recording for this session       |
| `!extract on`        | Resume memory recording                       |
| `!inject off`        | Turn off memory context for this session      |
| `!scope domain:code` | Set the scope for this session manually       |

View and edit your memory at [http://localhost:5757/beliefs](http://localhost:5757/beliefs).

## Per-agent isolation

If you use multiple OpenClaw agents, Tenure partitions memory automatically. A work agent that knows your codebase conventions, a finance agent that tracks your budget decisions, a personal agent that knows your writing voice -- none of them bleed into each other.

Tenure detects each agent's unique identifier and loads only the memory that belongs to it. Isolation is on by default. No configuration required.

Universal habits (like your preference for concise answers) apply across all agents. Everything else stays agent-specific.

To manually override a session's scope:

```
!scope domain:parenting
```

## Removing Tenure

Say "Remove Tenure" in any OpenClaw chat session. The skill will walk you through a clean removal including all data.

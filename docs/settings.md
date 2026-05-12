# Settings

Manage Tenure at `http://localhost:5757/admin`. Changes take effect immediately unless noted.

## Providers

Connect the upstream LLM providers Tenure routes requests to. Tenure supports two direct providers and any OpenAI-compatible endpoint.

**Anthropic**: paste your Anthropic API key. Supports prompt caching.

**OpenAI (or compatible endpoint)**: paste your API key and choose an endpoint type:

| Endpoint type          | When to use                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Generic OpenAI         | Standard OpenAI API or any compatible endpoint                                           |
| Bedrock Access Gateway | AWS Bedrock via BAG. Enables prompt caching, cutting input costs by up to 90%            |
| LiteLLM                | LiteLLM proxy. Caching hints are translated automatically where the upstream supports it |

For Bedrock Access Gateway and LiteLLM, a base URL is required. For Generic OpenAI it is optional: leave blank to use the default OpenAI endpoint.

See [providers.md](providers.md) for full setup details.

## Default Model

The model used for belief extraction and onboarding. Click **Browse** to load the available models from your configured provider. Models are grouped into three tiers:

- **Supported**: verified to produce reliable structured output for extraction
- **Unknown family**: unrecognized model, usable at your own risk
- **Below tier floor**: does not meet the minimum quality requirement, disabled

See [providers.md](providers.md) for the supported model list.

## Extraction

Toggles whether Tenure extracts new beliefs from conversations.

When **off**, Tenure still injects your existing beliefs into every session: your world model is still active, it just stops growing from new conversations. Use this for sessions you don't want recorded, or to pause extraction while you clean up your belief store.

Extraction can also be paused for a single request without touching this setting, by passing the header `X-Tenure-No-Extract: true` from your client.

## Scope

**Automatic scope detection**: when enabled, Tenure infers the domain from your first message each session and sets scope automatically. When disabled, scope is only set via explicit `!scope` commands or client metadata. In explicit-only mode, sessions without a declared scope surface only `user:universal` beliefs.

## Your Persona

The persona is a synthesized summary of who you are and how you work, injected into every session as standing context. It has two parts:

**Universal prelude**: applies to every session regardless of scope. Summarizes your communication style, working preferences, and expertise level drawn from onboarding answers and beliefs accumulated over time.

**Per-scope preludes**: domain-specific summaries that appear alongside the universal prelude when a scoped session is active. For example, a code scope prelude might describe your stack and conventions; a writing scope prelude might describe your voice and genre.

The persona is generated automatically from your onboarding answers and updated as your belief store grows. Click **Regenerate** to rebuild it from your current beliefs immediately: useful after a large import or a significant change to your world model.

## Advanced

These settings are hidden by default. Most users won't need to change them.

**Belief context token target**: how many tokens to budget for injected beliefs per request. Lower values mean less context per session; higher values inject more but increase cost and latency. Default: 400.

**History token cap**: the maximum number of tokens of compacted session history Tenure retains. History beyond this cap is dropped during compaction. Default: 120,000.

**Strict model tiers**: when enabled, only verified models can be selected as the default. Disable this if you are running a self-hosted or custom model that isn't in the supported list.

**History compaction mode**: controls how aggressively past session turns are collapsed:

| Mode         | What it does                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------ |
| Aggressive   | Collapses acknowledgments, deduplicated turns, and completed topics. Recommended for most users. |
| Conservative | Only collapses pure acknowledgments                                                              |
| Off          | Keeps all history. Uses significantly more tokens over time.                                     |

## API Token

Your bearer token for authenticating requests to Tenure. This is the token you paste into your client's API settings.

**Rotate token**: generates a new token immediately and invalidates the current one. Your active session will end. Copy the new token before dismissing the confirmation dialog: it is also saved to `~/.tenure/token` (Linux/macOS) or `%USERPROFILE%\.tenure\token` (Windows).

## Maintenance

**Run compaction now**: merges overlapping and redundant beliefs in your world model. Compaction runs automatically every 30 minutes. Trigger it manually after a large import or onboarding run to consolidate beliefs immediately.

## Backup & Restore

See [backup.md](backup.md) for full details.

**Export**: click **Preview** to see a count of what will be included (active beliefs, sessions, and whether a persona is present), then enter a passphrase and click **Export** to download an encrypted archive to your downloads folder.

**Import**: select a `.enc` archive file, enter the passphrase, and click **Import**. Two options are available:

- **Skip existing beliefs**: beliefs already in your world model with the same ID are left untouched. On by default.
- **Restore settings**: also restores provider credentials and configuration from the archive. On by default.

# Prompt Caching

Tenure structures its system prompt in tiers specifically to maximize prompt cache hits across all supported models. This document explains how the tiers work, what the minimum token thresholds are, and why the prompts are written the way they are.

## How caching is structured

Every request to Anthropic (and compatible endpoints via LiteLLM or Bedrock Access Gateway) sends the system prompt as a structured block array rather than a flat string. Each block can carry a `cache_control: ephemeral` marker, which tells the provider to cache that block independently.

Tenure uses two cached blocks and one uncached section per request:

**Static block** contains:

- The sidecar extraction instructions: type taxonomy, scope assignment rules, confidence guidance, alias rules, turn signal definitions, the full JSON example, and the security notice
- The persona prelude: a prose summary of who you are and how you want to be engaged, generated from your belief set

This block changes only when your persona cache is regenerated, which happens when your beliefs change meaningfully. Within a session it is effectively fixed.

**Beliefs block** contains:

- Interpretation rules telling the model how to weight beliefs, epistemic status, and open questions
- Your pinned facts for the current scope
- The relevant beliefs surfaced for the current query

This block changes when your belief set changes or when a different set of beliefs is retrieved for a new query. It is cached separately from the static block so a belief update does not invalidate the sidecar instructions.

**Dynamic section** (uncached) contains the relevant beliefs for the current turn, open questions, and any system prompt injected by your client. This section is not cached because it changes on every turn.

## Minimum token thresholds

Anthropic requires a minimum token count before a block qualifies for caching. If a block falls below the threshold it is billed as normal uncached input. The threshold varies by model tier: Sonnet models require 2,048 tokens; Haiku and Opus models require 4,096. See [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) for the current authoritative list, including any models added after this doc was written.

As Anthropic's documentation notes, if your prompt falls just short of the minimum for the model you are using, expanding the cached content to reach the threshold is often worthwhile. Cache reads cost significantly less than uncached input tokens, so clearing the minimum reduces costs for frequently reused prompts.

## Why the static block is long by design

The sidecar extraction instructions are written out in full rather than compressed. This is intentional for two reasons that reinforce each other.

**Reason one: token thresholds require it.** The static block needs to clear 2,048 tokens for Sonnet and 4,096 for Haiku and Opus before any caching applies. A compressed prompt that saves tokens in the static block costs more per request on every model that requires the higher threshold, because the block never qualifies for caching. The length is not a cost, it is an investment paid once per session.

**Reason two: explicit rules protect reasoning tokens.** Each instruction in the sidecar prompt is written so the model can apply it directly without reasoning over what it means. A rule like "confidence below 0.65 means low-certainty, weight accordingly" removes a decision the model would otherwise have to make. A decision table for scope assignment removes inference about domain generality. A lookup for epistemic status removes judgment about how a belief entered the conversation.

This matters because reasoning tokens are finite and expensive. Every instruction the model has to interpret before acting on is reasoning spent on prompt processing rather than on your actual task. The prompt is long so that cost is paid once at cache write time, not on every turn.

## Why the persona prelude is in the static block

The persona prelude sits in the static block alongside the sidecar instructions rather than in the beliefs block. The reason is cache invalidation.

The beliefs block changes whenever beliefs are updated or a different set is retrieved for a new query. If the persona prelude lived in the beliefs block, any belief update would invalidate it and force a re-cache of the full persona text. Since the persona prelude is stable within a session and only regenerates when your belief set changes meaningfully, placing it in the static block means it stays cached across belief retrievals.

## How the two blocks combine to meet higher thresholds

For models with a 4,096 token threshold, neither block reliably clears the minimum on its own for a new user with few beliefs. The two blocks work together:

- The static block contributes the sidecar instructions and persona prelude. For a user with an established persona this is typically 2,000 to 2,600 tokens depending on the scope variant rendered.
- The beliefs block contributes the interpretation rules, pinned facts, and relevant beliefs. For a user with moderate belief data this adds another 600 to 1,500 tokens.

Combined, both blocks clear the 4,096 threshold for most users once they have a session worth of belief data.

> **Note for new users on Haiku and Opus:** The combined total may fall short of the 4,096 threshold during your first session, before extraction has populated enough belief data. If you see no cache hits on day one, this is expected. After one session of extraction the totals will clear the threshold for subsequent sessions.

## Provider support

| Setup                        | Caching support                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic direct             | Full two-tier caching via `cache_control` blocks. See [Anthropic's prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).                                                       |
| LiteLLM                      | Full two-tier caching; `cache_control` markers are translated to Bedrock `cachePoint` blocks downstream                                                                                                              |
| Bedrock Access Gateway       | Single-tier caching via the `prompt_caching` extra body field; BAG handles segmentation internally. See [AWS Bedrock prompt caching docs](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html). |
| OpenAI and generic endpoints | No prompt caching; system prompt is sent as a flat string                                                                                                                                                            |

For LiteLLM and Bedrock Access Gateway setups, configure the endpoint flavor in the admin UI so Tenure sends the correct caching hints for your gateway. See [docs/clients.md](clients.md) for setup instructions by client type.

## Verifying cache hits

Anthropic returns cache usage in the response under `usage`:

```json
{
  "usage": {
    "input_tokens": 142,
    "cache_read_input_tokens": 3847,
    "cache_creation_input_tokens": 0,
    "output_tokens": 581
  }
}
```

`cache_read_input_tokens` shows how many tokens were served from cache rather than billed as input. On a session where the static block is cached, expect this number to be substantially larger than `input_tokens`.

# Provider Setup

Tenure supports any OpenAI-compatible upstream provider. Configure providers at `http://localhost:5757/admin/providers`.

## Supported providers

| Provider                       | Type                                  | Prompt Caching      |
| ------------------------------ | ------------------------------------- | ------------------- |
| Anthropic                      | Direct                                | Yes                 |
| OpenAI                         | Direct                                | Yes (some models)   |
| AWS Bedrock (Claude)           | Via Bedrock Access Gateway or LiteLLM | Yes                 |
| AWS Bedrock (Nova)             | Via Bedrock Access Gateway or LiteLLM | Yes                 |
| LiteLLM                        | Gateway                               | Depends on upstream |
| Ollama                         | Local                                 | No                  |
| Any OpenAI-compatible endpoint | Generic                               | No                  |

## Prompt caching

Tenure segments the system prompt into stable and dynamic tiers. On providers that support caching, the stable tiers (static instructions and belief context) are marked for caching. You pay for belief injection once per session, not on every turn.

On providers that do not support caching, the full system prompt is sent on every request. The belief budget is token-capped and adjustable in `Admin Panel > Settings > Context > Belief token ceiling`.

## LiteLLM

LiteLLM is the recommended gateway for broad provider coverage. Pointing Tenure at a LiteLLM instance gives you access to most major providers, with caching applied automatically where the upstream supports it.

```
Base URL: http://your-litellm-instance/v1
Auth: your LiteLLM key
Flavor: litellm
```

## Bedrock Access Gateway

For direct Bedrock access without LiteLLM:

```
Base URL: https://your-bag-endpoint/v1
Auth: your BAG key
Flavor: bedrock-access-gateway
```

## Adding a provider

_Full configuration reference coming soon._

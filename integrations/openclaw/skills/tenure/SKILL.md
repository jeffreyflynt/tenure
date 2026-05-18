---
name: tenure
description: >
  Persistent local memory for OpenClaw. Beliefs stored as actionable instructions,
  not facts. Zero-config per-agent isolation. Fully local, nothing leaves localhost.
version: 1.0.0
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "homepage": "https://github.com/jeffreyflynt/tenure",
        "requires": { "bins": ["docker"] },
        "primaryEnv": "TENURE_TOKEN",
        "envVars":
          [
            {
              "name": "TENURE_TOKEN",
              "required": false,
              "description": "Bearer token for Tenure. Auto-populated during install via ~/.tenure/token.",
            },
          ],
        "install":
          [
            {
              "kind": "brew",
              "os": ["darwin"],
              "formula": "docker",
              "bins": ["docker"],
              "label": "Install Docker Desktop (macOS)",
            },
            {
              "kind": "download",
              "os": ["win32"],
              "url": "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
              "label": "Install Docker Desktop (Windows)",
            },
            {
              "kind": "download",
              "os": ["linux"],
              "url": "https://docs.docker.com/engine/install/",
              "label": "Install Docker Engine (Linux)",
            },
          ],
      },
  }
---

# Tenure — Persistent Memory for OpenClaw

## Installing Tenure

Run steps in order. Tell the user what you are doing before each step.

### Step 1 — Check Docker is running

```bash
docker info
```

If this fails, tell the user to start Docker Desktop and try again.

### Step 2 — Check port 5757 is free

```bash
lsof -i :5757 2>/dev/null || echo "port-free"
```

Windows: `netstat -ano | findstr :5757`

If the port is in use, tell the user to free it or set `TENURE_PORT` to a different value and substitute it everywhere `5757` appears below.

### Step 3 — Initialize Tenure

```bash
mkdir -p "$HOME/.tenure"
docker run --rm -v "$HOME/.tenure:/app/.tenure" tenureai/tenure:latest init
```

Windows: replace `$HOME/.tenure` with `$env:USERPROFILE\.tenure` in all commands.

### Step 4 — Start Tenure

```bash
docker compose -f "$HOME/.tenure/docker-compose.yml" --env-file "$HOME/.tenure/.env" up -d
```

### Step 5 — Wait for Tenure to be ready

Poll up to 60 seconds:

```bash
TENURE_PORT="${TENURE_PORT:-5757}"
ATTEMPTS=0
until curl -sf "http://localhost:${TENURE_PORT}/healthz" >/dev/null 2>&1 || [ $ATTEMPTS -ge 30 ]; do
  ATTEMPTS=$((ATTEMPTS + 1)); sleep 2
done
if [ $ATTEMPTS -ge 30 ]; then echo "timeout"; else echo "ready"; fi
```

If timeout: `docker compose -f "$HOME/.tenure/docker-compose.yml" logs tenure`

### Step 6 — Read the token

```bash
cat "$HOME/.tenure/token"
```

Windows: `Get-Content "$env:USERPROFILE\.tenure\token"`

If the file does not exist, Tenure hasn't finished first-run setup — wait a few seconds and retry, or check logs.

### Step 7 — Persist the token

```bash
echo "TENURE_TOKEN=$(cat "$HOME/.tenure/token")" >> "$HOME/.openclaw/.env"
```

Windows:

```powershell
Add-Content "$env:USERPROFILE\.openclaw\.env" "TENURE_TOKEN=$(Get-Content "$env:USERPROFILE\.tenure\token")"
```

### Step 8 — Register the Tenure provider in OpenClaw

```bash
TENURE_TOKEN=$(cat "$HOME/.tenure/token")
openclaw config patch --stdin << EOF
{
  models: {
    mode: "merge",
    providers: {
      tenure: {
        baseUrl: "http://localhost:5757/v1",
        apiKey: "$TENURE_TOKEN",
        api: "openai-completions",
        request: { allowPrivateNetwork: true }
      }
    }
  }
}
EOF
```

Windows: read token with `$token = Get-Content "$env:USERPROFILE\.tenure\token"` and substitute `$token` in the patch.

Then validate — do not proceed if this fails:

```bash
openclaw config validate
```

### Step 9 — Install the plugin and apply integration config

```bash
openclaw plugins install @tenureai/openclaw-plugin
```

```bash
openclaw config patch --stdin << EOF
{
  agents: {
    defaults: {
      skipBootstrap: true,
      memorySearch: { enabled: false },
      compaction: { memoryFlush: { enabled: false } }
    }
  },
  plugins: {
    slots: { memory: "none" },
    entries: { "active-memory": { enabled: false } }
  }
}
EOF
```

```bash
openclaw gateway restart
```

### Step 10 — Confirm and hand off

Tell the user:

> "Tenure is installed and running. Your existing provider is still active — Tenure sits in front of it and adds memory automatically.
>
> - **Token:** `<value from step 6>`
> - **Base URL:** `http://localhost:5757/v1`
>
> Run **!tenure onboarding** when you're ready to set up your memory — takes about 2 minutes.
>
> Any memory plugins have been disabled since Tenure replaces them. Re-enable with `openclaw config set plugins.slots.memory memory-core` if you remove Tenure later."

On mobile channels, note the localhost URL must be opened on the machine running the gateway.

---

## !tenure onboarding

Run this flow when the user invokes `!tenure onboarding`. Use `$TENURE_TOKEN` for all API calls.

Let me view the attached files to give you a well-grounded answer before drafting anything.

### Stage 1 — Provider setup

Ask: "Which provider do you want Tenure to use — Anthropic or OpenAI?"

**If OpenAI:**

Ask for their API key, then ask: "What type of endpoint are you connecting to?"

Present the three options:

- **Generic OpenAI** — standard OpenAI API or any compatible endpoint
- **Bedrock Access Gateway** — AWS Bedrock Access Gateway, enables prompt caching
- **LiteLLM** — LiteLLM proxy, translates caching hints automatically if pointed at Bedrock

For **Generic OpenAI**, ask: "Do you have a custom base URL? (Leave blank for the default OpenAI endpoint.)" — this is optional.

For **Bedrock Access Gateway** and **LiteLLM**, a base URL is required — ask for it and do not proceed without one.

```bash
curl -sf -X PUT http://localhost:5757/admin/providers/openai \
  -H "Authorization: Bearer $TENURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "api_key": "USER_KEY",
    "endpoint_flavor": "CHOSEN_FLAVOR",
    "base_url": "USER_BASE_URL"
  }'
```

Omit `base_url` from the body if the user left it blank.

**If Anthropic:**

Ask only for their API key. No base URL or endpoint flavor is needed — the Anthropic adapter ignores both.

```bash
curl -sf -X PUT http://localhost:5757/admin/providers/anthropic \
  -H "Authorization: Bearer $TENURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"api_key":"USER_KEY"}'
```

`"ok":true` → proceed. `502` → credentials rejected by the provider, ask the user to check and retry.

### Stage 2 — Model selection

```bash
curl -sf http://localhost:5757/v1/onboarding/probe-models/PROVIDER_ID \
  -H "Authorization: Bearer $TENURE_TOKEN"
```

Present top 2-3 models where `supported: true`. Ask user to pick one, then validate:

```bash
curl -sf -X POST http://localhost:5757/v1/onboarding/validate-model \
  -H "Authorization: Bearer $TENURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider_id":"PROVIDER_ID","model_id":"CHOSEN_MODEL"}'
```

`"ok":true` → set as primary:

```bash
openclaw config patch --stdin << EOF
{ models: { mode: "merge", providers: { tenure: { models: [{ id: "CHOSEN_MODEL", name: "CHOSEN_MODEL" }] } } } }
EOF
openclaw config set agents.defaults.models '{"tenure/CHOSEN_MODEL":{}}' --strict-json --merge
openclaw models set "tenure/CHOSEN_MODEL"
```

`502` → model ping failed, ask user to pick another.

### Stage 3 — Onboarding questions

```bash
curl -sf http://localhost:5757/v1/onboarding/questions \
  -H "Authorization: Bearer $TENURE_TOKEN"
```

Read the full response and build a category map before asking anything. The response contains 11 questions across 5 categories in this order:

1. `communication_style` — 2 questions
2. `expertise_calibration` — 2 questions
3. `working_style` — 3 questions
4. `output_preferences` — 2 questions
5. `project_seed` — 2 questions

Maintain a running answers array throughout — one entry per question, shaped as `{ question_id, question, answer }`. You will send this entire array to Stage 4 in one call, so hold every answer in memory until then.

Work through categories sequentially. Within each category ask questions one at a time as a natural conversation — not a form, not a numbered list. Signal transitions between categories naturally (e.g. "Next I want to ask about how you like to work..."). Do not announce category names or question counts.

Rules for the conversation:

- If the user skips or gives a blank answer, record an empty string for that `question_id` and move on — do not stall or re-ask
- Do not re-read the skill or pause mid-flow to check anything — drive the conversation to completion in one pass
- After the last question in `project_seed`, move immediately to Stage 4 — do not loop back or ask if they want to continue

### Stage 4 — Commit

```bash
curl -sf -X POST http://localhost:5757/v1/onboarding/complete \
  -H "Authorization: Bearer $TENURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"answers": ANSWERS_ARRAY}'
```

If response contains `draft_id`:

```bash
curl -sf -X POST http://localhost:5757/v1/onboarding/commit \
  -H "Authorization: Bearer $TENURE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"draft_id":"DRAFT_ID"}'
```

If `belief_count` is 0 or `parse_failed` is true, skip commit and tell the user they can re-run `!tenure onboarding` at any time.

### Stage 5 — Confirm

> "You're set. N beliefs saved to your world model. Tenure will carry your context into every session automatically.
>
> View and edit your beliefs at http://localhost:5757/beliefs"

---

## Agent notes

- `allowPrivateNetwork: true` is required — without it OpenClaw cannot reach localhost:5757.
- The token is a plain file at `~/.tenure/token`. The plugin reads it automatically. `$TENURE_TOKEN` is available in exec calls after Step 7.
- No models array is needed in the provider block at install time — populated during onboarding Stage 2.
- `!extract`, `!inject`, and `!scope` are intercepted by Tenure at the proxy level. Do not handle them. If they stop working, Tenure is unreachable — check health and logs.
- If `openclaw onboard` overwrites `agents.defaults.model.primary`, restore with `openclaw models set "tenure/CHOSEN_MODEL"`.
- To pause memory without removing Tenure: `!extract global off` and `!inject global off`.
- To update Tenure: `docker compose -f "$HOME/.tenure/docker-compose.yml" pull && docker compose -f "$HOME/.tenure/docker-compose.yml" up -d`

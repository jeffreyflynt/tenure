# Changelog

All notable changes to OrgForge will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.8] - 2026-05-18

### Changed

- **OpenClaw plugin dev dependencies pinned to exact versions**: `@types/node` bumped to `25.6.0`, `ava` to `8.0.0`, `openclaw` to `^2026.5.18`, and `typescript` to `6.0.3`.
- **`openclaw` dependency tree updated**: Bumped internal packages including `@agentclientprotocol/sdk` to `0.21.1`, `@earendil-works/pi-*` packages to `0.75.1`, `@google/genai` to `2.3.0`, `@clack/core` to `1.3.1`, `@clack/prompts` to `1.4.0`, `kysely` to `0.29.1`, `openai` to `6.38.0`, `openclaw` to `2026.5.18`, `undici` to `8.3.0`, `tokenjuice` to `0.7.1`, `ws` to `8.20.1`, and `typescript` to `6.0.3`.
- **Proxy dependencies replaced in `openclaw`**: `proxy-agent`, `global-agent`, `pac-proxy-agent`, `pac-resolver`, and related transitive packages removed. Replaced with the lighter `@openclaw/proxyline@0.3.3`, `http-proxy-agent@7.0.2`, and `https-proxy-agent@7.0.6`.
- **`sharp@0.34.5` added as an optional dependency** to `openclaw`, along with its full platform-specific binary set.
- **`quickjs-wasi@2.2.0` promoted** from a peer dependency to a direct dependency of `openclaw`.
- **`brace-expansion` bumped** from `5.0.5` to `5.0.6` in the root `package-lock.json`.
- **Removed packages**: `uuid`, `extract-zip`, `cli-highlight`, `serialize-error`, `global-agent`, `proxy-agent`, `pac-proxy-agent`, `pac-resolver`, `degenerator`, `ast-types`, `escodegen`, `estraverse`, and several other transitive dependencies removed as part of the proxy and tooling cleanup.

---

## [1.0.7] - 2026-05-18

### Added

- **OpenClaw plugin integration (`integrations/openclaw/`)**: New first-class integration package `@tenureai/openclaw-plugin` with a GitHub Actions publish workflow, `openclaw.plugin.json` manifest, `package.json`, TypeScript source, and a full test suite. The plugin registers a Tenure provider in OpenClaw, handles per-agent session isolation via `x-agent-id` headers, seeds beliefs from `USER.md` and `MEMORY.md` on first encounter, and suppresses extraction and injection during agent bootstrapping.
- **`POST /v1/beliefs` endpoint**: New route for manually creating beliefs from the UI or API, with full validation of type, epistemic status, scope, and canonical name. Returns `409` on canonical name conflict.
- **`GET /v1/commands` endpoint**: New route returning the full list of Tenure chat commands with their effects and scopes.
- **`!session` command**: New `matchSessionCommand` and `tryInterceptSessionCommand` helpers allow the OpenClaw plugin to bind a session key and agent ID on each turn, with full test coverage.
- **`buildOpenClawExtractionSystemPrompt`**: Dedicated extraction system prompt for OpenClaw workspace file ingestion, with agent-scoped scope assignment rules and template-filtering guidance.
- **`New Belief` button in beliefs UI**: Inline creation modal with fields for type, canonical name, content, why it matters, scope, and aliases.
- **Aliases displayed in belief cards**: Alias badges now render below belief content in the UI.
- **Aliases editable in the edit modal**: The edit modal now includes a comma-separated aliases field.
- **`x-tenure-bootstrapping` header support**: Extraction and injection are suppressed when the OpenClaw agent is mid-bootstrap.
- **`docker-compose.yml` user field**: `user: "${UID:-1000}:${GID:-1000}"` added to the `tenure` service.

### Changed

- **`chown` moved after `init` exit in `entrypoint.sh`**: The `chown -R tenure:tenure` call now runs only on the normal startup path, not during `init`, avoiding a permission error when the mount is owned by the host user.
- **Agent scope pinning**: When `x-agent-id` is present on a request, the session scope is set directly from the agent identity rather than going through first-turn auto-detection.
- **`listPinnedFacts` query tightened**: The `$or: [{ user_edited: true }, { scope: { $in: scope } }]` branch has been removed; pinned facts now require scope match. `user_edited` beliefs no longer surface cross-scope.
- **`BeliefMerger` passes scope to `findByAliasOrCanonical`**: Deduplication during extraction is now scope-aware, preventing cross-scope canonical name collisions from blocking new beliefs.
- **`BeliefWriter.findByCanonicalName` and `findByAliasOrCanonical` accept optional `scope` filter**.
- **Sidecar prompt revised**: Scope assignment rules condensed to three priority rules, `user:universal` narrowed to direct communication-style statements, example beliefs updated, and the `epistemic_status` and `topic_label` instructions moved inline before the closing `SIDECAR_END`.
- **Import and onboarding extraction prompts updated**: `resolves_open_question`, expanded `TYPES` list, `CONFIDENCE` block with explicit thresholds, and revised `ALIASES` guidance added to both `buildImportExtractionSystemPrompt` and the onboarding extraction prompt.
- **`retrieval.cases.json` fixture updated**: `user-edited-cross-scope-surfaces` test case now asserts the belief is excluded (`mustExclude`) rather than included, reflecting the scope isolation fix. `maxBeliefs` budget case corrected from `3` to `2`.
- **`seeded_agent:` and `seed_attempted_at:` keys allowlisted** in `PUT /admin/config/:key` without requiring an explicit entry in the safe key set.
- **`SKILL.md` replaced**: The monolithic `integrations/openclaw/SKILL.md` has been removed and replaced with `integrations/openclaw/skills/tenure/SKILL.md`, rewritten with updated install steps (token now read from `~/.tenure/token`), a revised onboarding flow using the probe-models and validate-model endpoints, and expanded agent notes.
- **`BeliefsDeps` now requires `beliefWriter`**: Wired through from `server.ts` using a new `BeliefWriter` instance.

### Fixed

- **`saveEdit` in beliefs UI**: `aliasesRaw` variable was referenced before being declared; the assignment has been hoisted.

---

## [1.0.6] - 2026-05-15

### Changed

- **`docker-compose.yml`**: Add missing creds.

---

## [1.0.5] - 2026-05-15

### Added

- **`!inject` commands documented in settings.md**: The Injection section has been added to `settings.md`, covering all four `!inject` commands (`!inject off`, `!inject on`, `!inject global off`, `!inject global on`), their effects, and the interaction with `!extract off` for fully clean sessions.
- **Scope command documentation in settings.md**: A "Setting scope manually" subsection has been added under Scope, documenting the `!scope` and `set scope` command syntax, multi-scope usage, all valid scope format rules, and the automatic hierarchy expansion behaviour.
- **`entrypoint.sh` `init` mode**: The entrypoint script now supports an `init` subcommand that writes the bundled `docker-compose.yml` to `TENURE_HOME`, generates a random MongoDB password, and writes a `.env` file with credentials. Both writes are skipped if the target files already exist.
- **`TENURE_HOME` environment variable support in `entrypoint.sh`**: The entrypoint now reads `TENURE_HOME` from the environment, defaulting to `/app/.tenure`, instead of hardcoding the path.
- **`docker-compose.yml` copied into container image**: The Dockerfile now copies `docker-compose.yml` into `/app/docker-compose.yml` so it is available for the `init` entrypoint path.

### Changed

- **README rewritten**: The README has been substantially revised with updated framing, a condensed problem statement, an expanded "Why This Is Different" section, a new "Trust and Ownership" section, and a streamlined structure throughout. The title has been shortened to remove the explicit client name list.
- **`settings.md` Advanced section trimmed**: The `History token cap` setting and `History compaction mode` table have been removed from the Advanced section.

## [1.0.4] - 2026-05-14

### Added

- **Animated loading indicator on onboarding submission**: The "Extracting beliefs..." text is now replaced with a three-dot bounce animation and the Tenure logo while the onboarding completion request is in flight.
- **Tenure logo on onboarding error state**: The logo is now shown above the extraction failure and zero-beliefs error messages.
- **`extractJsonBlock` consolidated into shared module**: `onboarding.ts` now imports `extractJsonBlock` from `src/extraction/extractJson.ts` instead of maintaining a local copy.

### Changed

- **`extractJsonBlock` hardened**: Now handles trailing commas via `stripTrailingCommas`, normalizes Unicode curly quotes and smart apostrophes via `normalizeQuotes`, and uses a brace-depth-tracking `extractOutermostObject` instead of a simple regex match. Multiple fallback parse attempts are made before returning `null`.
- **`tenure` metadata field removed from chat completion responses**: The `tenure` envelope (`session_id`, `turn_id`, `scope`, `parse_status`, `degraded`, `context`) is no longer included in non-streaming chat completion responses. Tests updated accordingly.
- **`injectionEnabled` now suppresses injection for IDE clients**: IDE clients detected via `ua-parser-js` now have injection disabled by default, matching the existing extraction suppression behaviour.
- **Compacted history no longer injected into conversation messages**: `renderCompacted` is no longer called on the hot path; compacted turns are not prepended to the outgoing message array.
- **`EMPTY_RENDERED` import removed from `chat.ts`**: No longer needed after the compacted history removal.
- **Static assets copied into dist image**: `COPY src/static ./dist/static` added to the Dockerfile so static files are available at runtime.

### Removed

- **`parse_status` and `degraded` assertions removed from pipeline and chat integration tests**: Tests no longer assert on `tenure.parse_status` or `tenure.degraded` since the metadata field has been dropped from responses.

---

## [1.0.3] - 2026-05-13

### Added

- **`host.docker.internal` extra host mapping**: Added `host.docker.internal:host-gateway` to the Docker Compose service and install scripts (`install.sh`, `install.ps1`), allowing the container to reach services running on the Docker host.
- **`POST /admin/maintenance/compact` endpoint**: New admin route that triggers a belief compaction run manually. Returns `{ ok: true }` on success or a 500 with an error message on failure.
- **`compactionRunner` and `userId` on `AdminDeps`**: The admin router now accepts a `BeliefCompactionRunner` instance and a `userId`, wired through from `ServerDeps` in `server.ts`.

### Changed

- **Port binding made public in install scripts**: The `tenure` service port binding in both `install.sh` and `install.ps1` has been changed from `127.0.0.1:${TENURE_PORT:-5757}:5757` to `${TENURE_PORT:-5757}:5757`, allowing the service to bind on all interfaces rather than localhost only.

---

## [1.0.2] - 2026-05-12

### Added

- **`entrypoint.sh` support**: A dedicated entrypoint script is now copied into the container image and set as the `ENTRYPOINT`, replacing the previous approach of running directly as the `tenure` user via `USER`.
- **`gosu` dependency in runtime image**: Installed in the runtime stage to support controlled user switching from the entrypoint script.
- **`ca-certificates` in crypt stage**: Added alongside `curl` for more reliable TLS handling during the crypt library download.

### Changed

- **Base image changed from Alpine to Debian Slim**: All build stages (`crypt`, `deps`, `build`) now use `node:25-bookworm-slim` instead of `node:25-alpine`, aligning all stages with the existing runtime stage.
- **`npm ci` now runs with scripts enabled**: The `--ignore-scripts` flag has been removed from the `deps` stage.
- **`tenure` system user hardened**: The user is now created with `--no-create-home` and `--shell /usr/sbin/nologin` to reduce the attack surface.
- **Docker Compose service renamed**: The service previously named `proxy` has been renamed to `tenure` in both `install.sh` and `install.ps1`.
- **`getBeliefMasterKeyPath` now accepts `TENURE_HOME`**: The call in `app.ts` now passes `process.env.TENURE_HOME` to allow the belief master key path to be configured via environment variable.

---

## [1.0.1] - 2026-05-12

### Added

- **`!inject` command**: Belief injection can now be paused and resumed per-session with `!inject off` / `!inject on`, or globally with `!inject global off` / `!inject global on`, mirroring the existing `!extract` command surface.
- **`injection_enabled` runtime config flag**: Global injection toggle added to `RuntimeConfig` with a default of `true`. Exposed in the admin UI alongside the existing extraction toggle.
- **`injectionPaused` session field**: Sessions now track injection pause state independently from extraction pause state. Both flags compose with their respective global flags.
- **`clientCategory` on extraction jobs**: The parsed client category from the `User-Agent` header is now recorded on extraction job payloads for logging and analytics.
- **`ua-parser-js` dependency**: Added for structured User-Agent parsing. IDE clients detected this way suppress extraction by default.
- **`X-Tenure-No-Extract` header**: Per-request extraction suppression without touching session or global state.
- **File attachment support in Anthropic adapter**: `file` content parts with data URLs are now translated to Anthropic `document` blocks with MIME type validation. Unsupported types degrade gracefully to a text placeholder.
- **Tool call support in OpenAI adapter**: Streaming and non-streaming paths now accumulate and surface tool call deltas in `stream_end` and non-streaming responses.
- **Adaptive extraction sweep**: The background sweep job now backs off exponentially (up to 5 minutes) when consistently finding no work, and resets to the 1-minute base interval when work is found.
- **`!extract` command**: Per-session and global extraction control directly from the chat client, without opening Settings.
- **`_id` field added to Atlas Search index mappings**: Enables `mustNot` exclusion of specific belief IDs at the Atlas Search layer rather than in a downstream `$match` stage, improving query efficiency.

### Changed

- **Context assembly**: `context.build()` is now skipped entirely when injection is paused, avoiding unnecessary MongoDB and vector search round trips.
- **System prompt construction**: Persona framing, pinned facts, relevant beliefs, and open questions are omitted from the system prompt when injection is off. Extraction instructions are omitted when extraction is off.
- **Pinned belief deduplication**: Pinned belief IDs are now passed as `excludeIds` directly into `searchText` so deduplication happens at the Atlas Search layer rather than in application code after the fact.
- **`extractLatestUserMessage` renamed to `extractLatestUserText`**: Now handles `ContentPart[]` message content in addition to plain strings.
- **`mergeSystemPrompt` in OpenAI adapter**: Now safely extracts text from `ContentPart[]` system message content instead of coercing to `"[object Object]"`.
- **`max_tokens` default in Anthropic adapter**: Raised from `4096` to `8192`.
- **`openai` package removed as a dependency**: The direct `openai` npm package has been dropped.
- **`@aws-sdk/client-bedrock-runtime` removed**: Dependency fully removed from `package-lock.json` and `package.json`.
- **Scope prompt simplified**: Scope assignment instructions condensed to a four-rule priority list instead of a multi-bullet explanation.
- **`epistemic_status` prompt clarified**: Inline rules in the sidecar prompt now make the three states unambiguous and explicitly note that corrections are always `active`.
- **`CONFIDENCE` block added to sidecar prompt**: Explicit thresholds (0.9-1.0 / 0.75-0.89 / 0.5-0.74 / omit) now appear inline in the extraction prompt.
- **`WORLD STATE` type mapping clarified in sidecar prompt**: Explicit rules for when to emit `entity`, `decision`, or both.
- **`SOURCE RULE` block expanded in sidecar prompt**: Pasted reference material is now explicitly excluded from extraction with examples.
- **Anthropic adapter `listModels`**: Auth failures now surface as thrown errors rather than silently returning an empty list.
- **OpenAI adapter `listModels`**: 401 responses now throw a `ProviderError` rather than returning an empty list. Added a 10-second timeout.
- **OpenAI adapter `call` and `stream`**: Both paths now apply a 120-second `AbortSignal.timeout`. Non-present `model` field now throws an explicit error.
- **`PersonaSummaryService.regenerate` removed**: Callers use `invalidate` + `get` directly. In-flight deduplication added to prevent concurrent regeneration for the same user.
- **`listAlwaysOn` removed from `BeliefsReader` interface**: All call sites updated.
- **`scope_auto_detect` and `injection_enabled` added to the safe admin config key set**: Both keys are now accepted by the `PUT /admin/config/:key` route.
- **`scopePrelude` assertions removed from eval test cases**: Scope prelude checks removed from both BM25 and vector eval runners.
- **`content` field removed from Atlas Search index**: `lucene.english` analyzer on `content` dropped from the search index definition.
- **Jobs index key extended**: Pending jobs index now includes `created_at` as a tertiary sort key.
- **`beliefs` route `redactForClient`**: Now includes `scope` and `aliases` fields in the client-facing belief representation.
- **Error forwarding in server error handler**: A safe-list of error message patterns (auth failures, rate limits, missing model/provider) are now forwarded to the client verbatim instead of being replaced with `"internal server error"`.
- **Extraction sweep job**: Refactored from `SimpleIntervalJob` with a fixed 1-minute interval to an adaptive scheduler with exponential backoff.
- **`tslib` moved to devDependencies**: No longer a runtime dependency.
- **All runtime and dev dependencies pinned to exact versions** (carried forward from 1.0.1, now reflected in `package-lock.json`).

### Fixed

- **`PersonaSummaryService`**: Hash check now occurs before the LLM call, and a re-check after the LLM call prevents a race where two concurrent regenerations both write. In-flight deduplication prevents redundant parallel calls for the same user.
- **`install.sh` retry URL**: Now points to the correct raw GitHub URL instead of a placeholder domain.
- **`ipaddr.js`**: Bumped from `2.3.0` to `2.4.0`.
- **`pino`**: Downgraded from `10.3.1` to `9.14.0`; `pino-abstract-transport` correspondingly downgraded from `3.0.0` to `2.0.0`; `thread-stream` from `4.0.0` to `3.1.0`.

# Changelog

All notable changes to OrgForge will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

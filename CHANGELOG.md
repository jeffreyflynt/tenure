# Changelog

All notable changes to OrgForge will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.15] - 2026-05-21

### Added

- **Beliefs sidebar** (`integrations/vscode/src/beliefsViewProvider.ts`): New Activity Bar panel ("Active Beliefs") that displays live beliefs for the current project via a WebSocket connection. Only visible when a token is configured.
- **`Tenure: Record Project Belief` command**: Opens the beliefs sidebar form to record a belief directly from the command palette.
- **`Tenure: Record Belief from Selection` command**: Same as above, also accessible via the editor right-click context menu when text is selected.
- **WebSocket beliefs route** (`src/routes/beliefs-ws.ts`): Server-side WebSocket endpoint powering real-time belief updates to the sidebar, backed by a MongoDB change stream (`src/db/beliefChangeStream.ts`).

### Changed

- **VS Code extension bumped to `1.0.15`**.
- **Project scope resolution simplified**: The manifest-walking approach (scanning for `package.json`, `Cargo.toml`, `go.mod`, etc.) has been replaced. Project name is now resolved from a plain-text `.tenure` file at the workspace root (just your project name on a single line), with git remote and folder-slug as fallbacks. The file watcher now only watches `.tenure` instead of all manifest files.
- **`tenureConfig.ts` simplified**: `.tenure` is now parsed as plain text rather than JSON. The `TenureProjectConfig` interface is removed.
- **`active_package` field removed** from `WorkspaceState`, workspace route, and `WorkspaceStateCache` — superseded by the simplified scope model.
- **`WorkspaceSync` gains result caching**: `cachedProjectName` and `cachedGitRemote` fields avoid redundant resolution on each sync. Cache is invalidated on `.tenure` file changes.
- **`@fastify/websocket` registered** in `server.ts` to support the new WebSocket route.
- **OpenClaw publish workflow**: Tag prefix changed from `v*` to `openclaw-v*`; publish target updated from `tenurehq/tenure@main` to `@tenureai/openclaw-plugin@<version>`.
- **VS Code test runner pinned** to VS Code `1.121.0`; `@vscode/test-cli` downgraded to `0.0.11`.

### Removed

- **`packageResolver.ts`** and its test suite deleted — manifest-based project resolution is no longer used.

---

## [1.0.14] - 2026-05-19

### Added

- **VS Code extension** (`integrations/vscode`): New native extension that syncs workspace context to the Tenure proxy on every file switch. Includes manifest-based project resolution (supports `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `pom.xml`, `.sln`, and others), git remote fallback, a `.tenure` config override, a status-bar indicator, and secure token storage. Ships with full test coverage (`packageResolver`, `tenureConfig`, `workspaceSync` suites).
- **Workspace state cache** (`src/workspace/stateCache.ts`): MongoDB-backed store for IDE-pushed workspace state (project name, active package, active file, language, git remote).
- **IDE scope resolver** (`src/workspace/scopeResolver.ts`): Derives project and language scope from cached workspace state or system-prompt heuristics. Tested against MongoDB Memory Server.
- **IDE extraction mode** (`src/extraction/worker.ts`, `src/jobs/queue.ts`, `src/types/job.ts`): Extraction jobs now carry an `extraction_mode` (`"standard"` | `"ide"`) and a `workspace_context` block. IDE-mode extractions enforce project scope and inject active-package aliases automatically.
- **IDE sidecar prompt** (`src/sidecar/idePrompt.ts`): Dedicated sidecar instruction builder for IDE turns, separate from the standard chat path.
- **Workspace route** (`src/routes/workspace.ts`): New endpoint for the VS Code extension to push workspace state.
- **`onboarding_drafts` collection** (`src/db/collections.ts`, `src/db/indexes.ts`): Persists onboarding draft state with a 7-day TTL and per-user index.
- **`ide_extraction_enabled` runtime config flag**: Toggles IDE-specific extraction; included in backup export/import.
- **`provenance_hint` on extraction signals** (`src/extraction/types.ts`): Accepts `"demonstrated"` or `"config_artifact"` to tag the origin of a belief.
- **Demonstrated-belief promotion logic** (`src/extraction/merger.ts`): Beliefs tagged as demonstrated or config-derived are promoted after 3 occurrences within a 24-hour window.
- **Scope badges on the Beliefs UI** (`src/routes/beliefs-ui.ts`): Scope tags now render as colored inline badges.
- **Richer error cards in Admin UI** (`src/routes/admin-ui.ts`): Error log entries now display provider, model, session ID, and turn ID alongside severity, stage, and timestamp.
- **Docs**: New `docs/clients/openclaw.md` and `docs/clients/vscode.md` client guides; `docs/clients.md` expanded into a structured chat/IDE/agent table with Docker networking notes.

### Changed

- **README rewritten**: Condensed and reorganized around concrete failure scenarios ("old decisions resurface," "ruled-out approaches keep coming back"), with a shorter quick-start and a "Private by design" section.
- **GitHub org renamed** (`jeffreyflynt` → `tenurehq`): All repository URLs, publish workflow references, and `package.json` fields updated.
- **Publish workflow**: `npm version` replaced with a direct `jq` edit to avoid git tag side-effects.
- **`x-tenure-ide` header detection** (`src/routes/chat.ts`): Chat route reads this header to switch into IDE mode and route to the IDE sidecar prompt.
- **Anthropic provider `max_tokens` cap raised** (`src/providers/anthropic.ts`): Now defaults to 120,000 if not specified by the caller.
- **Beliefs route `max_tokens` raised** to 8,000; compaction runner `max_tokens` raised to 5,000.
- **Admin error log projection** (`src/routes/admin.ts`): Now includes `turn_id`, `passthrough_succeeded`, `exception_type`, and `stack_trace` fields.
- **`.gitignore`**: Added `.vscode-test` and `.vscode` entries.

---

## [1.0.13] - 2026-05-19

### Added

- **Agent isolation (`agent_id`) across the belief system**: Beliefs, sessions, extraction jobs, contradictions, and compaction now track an `agent_id` field, enabling per-agent belief partitioning. All readers, writers, and queries filter by agent identity so that beliefs belonging to one agent do not leak into another's context.
- **`belief_contradictions` collection and detection pipeline**: The compaction runner now detects contradicting beliefs within a scope and persists them as `BeliefContradiction` documents with `pending`/`resolved` status. Dedicated indexes (`contradictions_agent_scope_status`, `contradictions_pending_recent`) support efficient querying.
- **`enriched` change kind for belief updates**: A new `"enriched"` signal allows the sidecar to append minor attributes to an existing entity without replacing its content. The merger calls the new `BeliefWriter.enrichContent` method, and the validator accepts `"enriched"` as a valid change kind.
- **`enrichContent` method on `BeliefWriter`**: Appends content to an existing belief, records the change in `change_log`, and returns success status.
- **`findByCanonicalNames` method on `BeliefsReader`**: Batch lookup of beliefs by canonical name with scope and agent filtering.
- **Sidecar prompt: belief enrichment guidance**: Explicit rules and examples for when to emit an `"enriched"` signal versus creating a new belief or superseding.
- **Expanded model support in `tiers.ts`**: Added detection and floor definitions for Bedrock GPT-OSS 120B, Bedrock Mistral Large 3 (675B), and Qwen3-235B-A22B-2507. GPT-4.1-mini and GPT-4.1-nano version extraction added.
- **`status` field on `SupportedFamilySummary`**: Each supported family now reports whether it is `"verified"` or `"community"`.
- **Repository metadata in OpenClaw plugin `package.json`**: Added `repository` field pointing to the GitHub repo with directory context.
- **`resolveScope` helper in chat route**: Extracted scope resolution logic into a dedicated async function with clear priority: agent identity wins unconditionally, then session-persisted scope, then first-turn auto-detection.

### Changed

- **OpenClaw plugin version bumped to `1.0.13`**: Both `openclaw.plugin.json` and `package.json` updated from `1.0.0` to `1.0.13`.
- **OpenClaw plugin session-agent map removed**: The in-memory `sessionAgentMap` with its bounded LRU eviction has been removed. Agent identity is now resolved directly from the context object on `session_start` and `resolveTransportTurnState`, eliminating the `before_tool_call` listener entirely.
- **OpenClaw plugin seeding moved to `session_start`**: `maybeSeedAgent` is now called eagerly during `session_start` for non-main agents instead of being deferred.
- **`--name tenure` removed from publish workflow**: The `--name` flag has been dropped from both the live and dry-run `openclaw plugin publish` commands.
- **Compaction runner refactored for agent-aware partitions**: `findQualifyingScopes` renamed to `findQualifyingPartitions`, grouping by both `scope` and `agent_id`. The `compact` method builds agent-isolation filters and handles `$or` collisions between type and agent filters.
- **Compaction LLM prompts updated**: Both `DEDUP_COMPACTION_PROMPT` and `PREFERENCE_COMPACTION_PROMPT` now instruct the model to detect and return contradictions alongside merges. `max_tokens` raised from 2000 to 20000.
- **`BeliefsReader` methods accept `agentId` parameter**: `listAlwaysOn`, `listPinnedFacts`, `listByScope`, `searchText`, `listPinnedOpenQuestions`, and `countActive` all support optional agent filtering via a new `mergeFilter` helper that safely combines `$or` clauses.
- **`ContextBuilder.build` accepts `agentId`**: Agent identity is threaded through to all belief reader calls and Atlas Search filters.
- **Atlas Search index updated to version 2**: `agent_id` added as a `token` field in the beliefs search index mapping. Agent isolation in text search uses a compound `should` clause with `minimumShouldMatch: 1`.
- **`BeliefMerger.merge` accepts `agentId`**: Passed through to `processSignal`, `insertNewBelief`, and `insertOpenQuestion` so all created beliefs inherit the correct agent.
- **Extraction job queue includes `agent_id`**: `EnqueueParams` accepts `agentId`, written to the job document for downstream use by the worker.
- **Session model includes `agentId` field**: `Session`, `SessionPatch`, and backup export/import types now carry `agentId`.
- **Belief type includes `agent_id` field**: The core `Belief` interface now requires `agent_id: string | null`.
- **`ExtractionJob` type includes `agent_id`**: Optional `agent_id` field added to the job interface.
- **Chat route passes `agentId` to context build, side effects, and streaming context**: The resolved agent ID flows end-to-end through injection, extraction enqueue, and streaming.
- **`readSidecarFlags` simplified**: `topicLabel` removed from `SidecarFlags`; topics array in side effects defaults to empty.
- **README model table expanded**: Added GPT-4.1-mini, Bedrock Nova 2/Premier (Nova Lite excluded), Bedrock GPT-OSS 120B (20B excluded), Bedrock Mistral Large 3, and Qwen3-235B-A22B-2507. Added a "floors" explanatory note.
- **Onboarding extraction `max_tokens` raised**: Bumped from 2000 to 4000.
- **Sidecar prompt example revised**: Replaced `prefers_direct_answers` example with an `expertise` subtype example (`javascript_react_expertise`). Removed `topic_shift` and `topic_label` fields from the example output.
- **`extractGptVersion` extended**: Now recognizes `gpt-4.1`, `gpt-4.1-mini`, and `gpt-4.1-nano` model IDs with appropriate version numbers.
- **`openai-o-series` regex broadened**: Detection pattern changed from `/^o[3-9]/i` to `/^o[3-9]\d*/i` to match multi-digit o-series models.
- **`bedrock-nova-pro` detection broadened**: Now matches `nova-pro`, `nova-premier`, and `nova-2` patterns.
- **Expertise synthesis now inherits `agent_id`**: New expertise beliefs copy agent identity from the existing expertise belief or the first source belief.

### Removed

- **`topic_label` from sidecar output schema**: The field is no longer extracted or used for topic tracking.
- **`topic_shift` from sidecar output schema**: Removed alongside `topic_label`.
- **`expandScopeHierarchy` import from chat route**: No longer used after scope resolution refactor.
- **In-memory `sessionAgentMap` from OpenClaw plugin**: Replaced by direct context reads.

---

## [1.0.12] - 2026-05-18

### Changed

- **`publish-openclaw-plugin.yml`**: Automate version updates to package.json.

---

## [1.0.11] - 2026-05-18

### Changed

- **`package.json`**: Install missing dependencies `@typescript/native-preview` & `tsx`.

---

## [1.0.10] - 2026-05-18

### Changed

- **`publish-openclaw-plugin.yml`**: Publish on new tags instead of release.

---

## [1.0.9] - 2026-05-18

### Added

- **`*.tgz` added to `.gitignore`** .
- **Type export added to OpenClaw plugin `package.json`**: The `exports` map now includes a `types` condition pointing to `./dist/index.d.ts`, and a top-level `types` field has been added alongside it.
- **Source maps enabled in `tsconfig.json`**: `sourceMap` flipped from `false` to `true`.

### Changed

- **`SKILL.md` metadata block converted from JSON to YAML**: The embedded `openclaw` metadata object has been reformatted from inline JSON to clean YAML. `curl` has also been added as a required binary alongside `docker`, and the Windows and Linux install entries have been removed.
- **`resolveToken` simplified**: The multi-step fallback chain (token file, `.env` file, `TENURE_TOKEN` env var) has been removed. The function now throws an explicit error if no token is provided in config, directing the user to run `!tenure onboarding`.
- **AVA `extensions` config changed from object to array**: The `extensions` field in `package.json` test config has been corrected from `{ "ts": "module" }` to `["ts"]`.
- **`tsconfig.json` excludes tightened**: Test files (`**/*.test.ts`), fixtures (`**/__fixtures__/**`), and mocks (`**/__mocks__/**`) are now explicitly excluded from the TypeScript build.

### Removed

- **`resolveToken` env var fallback tests removed**: The `resolveToken falls back to TENURE_TOKEN env var` and `resolveToken returns empty string when nothing available` test cases have been dropped, reflecting the simplified token resolution logic.

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

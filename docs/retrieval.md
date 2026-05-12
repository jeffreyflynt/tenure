# Retrieval

Tenure assembles a belief context on every request by combining three layers: a persona prelude, pinned facts, and relevant beliefs surfaced by text search.

## How context is assembled

**Persona prelude:** A short prose summary of your universal and scope-specific preferences, generated from your belief set and cached until your beliefs change. This is the first thing injected and is always present.

**Pinned facts:** All active pinned beliefs for the current scope, always injected regardless of query content.

**Relevant beliefs:** Non-pinned beliefs surfaced by text search against your query. The search matches against canonical names and aliases with fuzzy matching and scope filtering applied. Results are scored and ranked before injection.

All three layers are budgeted within a token ceiling. Pinned facts take priority; relevant beliefs fill remaining space.

## Search design

Retrieval is precision-first. The system would rather surface nothing than surface the wrong thing. Search matches on canonical names and aliases, not on belief content. This keeps results tightly scoped to what the belief is actually about.

Aliases are the retrieval surface. The extraction worker generates aliases with future text search in mind: abbreviations, shorthands, and alternate framings you might type in a future session. The compaction worker enriches aliases over time as it merges overlapping beliefs.

Fuzzy matching (one edit distance) is applied at query time with a prefix guard to block false positives. Short aliases like `k8s`, `TS`, and `GHA` use exact matching only.

## Scope isolation

Scope filtering is applied after search scoring. A query in `domain:code` will never surface a belief scoped to `domain:writing`, even if the search terms overlap. This is what prevents your engineering preferences from appearing in a writing session and vice versa.

## Known tradeoffs

**Verbose queries:** Very long or filler-heavy queries may lose retrieval signal because the meaningful terms are diluted. Pinning the beliefs most relevant to your current work is the most direct mitigation.

**Short alias substitution:** A one-character substitution in a short alias (for example, `k9s` instead of `k8s`) will not fuzzy-match because the prefix guard blocks it. This is intentional: the alternative is too many false positives on short tokens.

**Content is not searched:** Belief content is injected payload, not retrieval surface. A query that matches a belief's substance but does not use its canonical name or a registered alias will not surface it via text search. It may still appear via pinning. If a belief is not surfacing when you expect it, check its aliases or pin it.

_For guidance on getting the most out of retrieval, see [beliefs.md](beliefs.md)._

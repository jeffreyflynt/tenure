# Tenure Retrieval Evaluation

The claims in the paper rest on a controlled comparison between two retrieval
backends, alias-weighted BM25 and cosine similarity over dense embeddings,
run against identical seed corpora with identical assertion logic. This
document explains how to reproduce those results.

## What the Evaluation Covers

The suite has 72 cases across four test files:

**Static evaluation (60 cases)** — single-query retrieval against a fixed
30-belief seed corpus. Covers:

- Alias resolution (short forms, natural-language proxies, cross-scope aliases)
- Scope disambiguation (same alias, different scopes)
- Supersession chain exclusion (multi-hop chains)
- Fuzzy matching and prefix guards
- Cross-user isolation
- Cold start behavior
- Budget eviction and capacity
- Ranking stability (IDF weighting)
- Persona prelude content
- Type routing and open questions
- Design boundary cases including counter-signal retrieval

**Session-level evaluation (12 cases)** — multi-turn drift session testing
noise isolation under topic accumulation pressure. A Redis topic is
established at turn 0, followed by 8 drift turns across unrelated topics,
followed by implicit and explicit re-entry turns. Noise check assertions
verify that drift-turn beliefs do not contaminate re-entry retrieval.

Each run produces a JSON report in `test-results/` with per-case scores,
retrieved belief IDs, and clause-level BM25 score attribution.

## Prerequisites

- Docker
- Node.js 18+
- Dependencies installed: `npm install`

That is it for both BM25 evaluations. The vector evaluation uses a
pre-embedded seed file (`beliefs.seed.embedded.json`) committed alongside
the seed corpus. No Ollama installation is required to run the vector eval
unless you want to regenerate embeddings with a different model (see
Regenerating Embeddings below).

To reproduce the exact results reported in the paper, check out the
`arxiv-submission` tag before running any eval commands:

​`bash
git checkout v1.0.0-paper
​`

## Running the BM25 Evaluation

### Static cases

```bash
npx ava src/eval/retrieval.eval.test.ts --timeout=5m
```

### Session cases

```bash
npx ava src/eval/session-retrieval.eval.test.ts --timeout=5m
```

Each command:

1. Pulls `mongodb/mongodb-atlas-local:8` if not cached
2. Starts a temporary container on an isolated port
3. Creates the search index and waits for READY status
4. Seeds the belief corpus
5. Runs all cases serially
6. Writes the report to `test-results/`
7. Stops and removes the container

The BM25 eval requires no external services beyond Docker.

## Running the Vector Evaluation

### Static cases (vector)

```bash
npx ava src/eval/retrieval.vector.eval.test.ts --timeout=5m
```

### Session cases (vector)

```bash
npx ava src/eval/session-retrieval.vector.eval.test.ts --timeout=5m
```

The vector eval reads from `beliefs.seed.embedded.json`, which is committed
to the repository. No Ollama installation is required at test runtime.

## Running the Static Evals Together

```bash
npm run test:eval
```

This runs all eval files matching `src/**/*.eval.test.ts` — the two static
evals only. The BM25 and vector static evals use different container names
and ports and can run concurrently.

The session evals must be run separately (see above). The BM25 session eval
filename does not match the glob pattern.

## Regenerating Embeddings (Optional)

The committed `beliefs.seed.embedded.json` was generated with
`nomic-embed-text` at 768 dimensions. This file is the basis for the vector
results reported in the paper. You do not need to regenerate it to reproduce
those results.

If you want to evaluate a different embedding model:

```bash
OLLAMA_EMBED_MODEL=your-model npx tsx src/__fixtures__/embed-seed.ts
```

This requires Ollama running locally:

```bash
ollama pull your-model
```

The script writes a new `beliefs.seed.embedded.json`. Regenerating with a
different model changes the vector eval results; the paper's reported results
(8/72, drift scores 0.43–0.50) used `nomic-embed-text` and are not
reproducible with a different model.

## Reading the Reports

Each eval writes a JSON report to `test-results/`:

| File                                   | Contents               |
| -------------------------------------- | ---------------------- |
| `retrieval-report.json`                | BM25 static results    |
| `retrieval-report-vector.json`         | Vector static results  |
| `session-retrieval-report.json`        | BM25 session results   |
| `session-retrieval-report-vector.json` | Vector session results |

### Static report structure

Each entry corresponds to one test case:

```json
{
  "caseId": "alias-ts-resolves",
  "description": "Alias 'TS' drives text-search retrieval.",
  "expandedQuery": "TS strict mode question about unknown types",
  "pinnedBeliefs": [
    "b-prose-style-user-edited",
    "b-db-decision",
    "b-linting-current"
  ],
  "relevantBeliefs": ["b-ts-pref"],
  "retrievedQuestions": ["b-auth-open-q"],
  "searchScores": [
    {
      "id": "b-ts-pref",
      "score": 6.07,
      "clauses": [{ "path": "aliases", "term": "ts", "score": 6.07 }]
    }
  ],
  "retrievalPrecision": 1,
  "retrievalRecall": 1,
  "passed": true,
  "failures": []
}
```

**searchScores** contains the BM25 score breakdown per retrieved belief. Each
clause identifies which field path matched, which term matched it, and what
score that match contributed. This is the mechanism described in Section 4.3
of the paper: every retrieval decision is inspectable rather than opaque. The
`scoreDetails` flag is disabled for the vector eval because cosine similarity
scores have no equivalent clause breakdown. The vector report omits the
`clauses` array entirely.

**retrievalPrecision** and **retrievalRecall** are computed over the
`shouldOnlyInclude` or `mustInclude` sets defined in the case fixture. A
precision of 1.0 means every returned belief was expected. A recall of 1.0
means every expected belief was returned.

**personaPrelude** contains the generated prose string injected as standing
behavioral instruction. Persona prelude cases assert `nonEmpty`, `isNull`,
`contains`, or `mustNotContain` properties rather than belief IDs. A passing
persona prelude case confirms the prelude was generated from the correct
belief sources for that scope.

### Session report structure

Each entry corresponds to one turn within a session case:

```json
{
  "caseId": "redis-drift-reentry",
  "turnIndex": 9,
  "label": "implicit_continuation",
  "expandedQuery": "Ok circling back to what we were talking about at the start...",
  "retrievedBeliefIds": [],
  "pinnedBeliefIds": ["b-db-decision", "b-linting-current"],
  "noiseBeliefIds": [],
  "driftScore": 0.0,
  "passed": true,
  "failures": [],
  "searchScores": []
}
```

**driftScore** is computed as:

```
driftScore = noiseBeliefIds.length / (relevantIds.size + pinnedIds.size)
```

Both retrieved relevant beliefs and pinned beliefs count toward the
denominator. A turn that returns 3 pinned beliefs and 1 noise belief has a
drift score of 0.25, not 1.0. A drift score of 0.0 indicates perfect noise
isolation. The paper reports BM25 drift scores of 0.0 across all session
turns and vector drift scores of 0.43–0.50 on noise-critical turns 9 and 10.

## Expected Results

Running both backends against the published seed corpus should reproduce the
following results:

| Backend               | Static cases | Session cases | Total | Mean precision |
| --------------------- | ------------ | ------------- | ----- | -------------- |
| BM25 (alias-weighted) | 60/60        | 12/12         | 72/72 | 1.0            |
| Vector (cosine)       | 8/60         | 0/12          | 8/72  | 0.12           |

The vector backend passes the 7 static cases where the correct belief is the
only belief in scope; scope isolation does the work that retrieval precision
cannot. On every case where multiple beliefs occupy the same scope, vector
search fails the precision assertion.

## Seed Corpus

The seed corpus is fixed and committed at tag `v1.0.0-paper`. To
guarantee an identical corpus, check out that tag before running evals.

The evaluation runs against a fixed 30-belief seed corpus defined in
`src/__fixtures__/beliefs.seed.json`. The corpus contains:

- One primary user's beliefs spanning two domain scopes (`domain:code` and
  `domain:writing`)
- A three-hop supersession chain (TSLint → ESLint → Biome), of which 2
  beliefs are superseded and retained for audit
- A single secondary-user fixture for cross-user isolation validation
- Counter-signal aliases (the `moongoose` alias on `b-mongo-raw-driver` —
  intentional misspelling, not a typo)
- Scope-conflicting aliases (both Redis beliefs share the alias `redis`)
- 4 superseded beliefs retained in the corpus for audit (not injectable)
- 2 resolved open questions (not injectable)

The seed corpus is fixed and committed. Do not modify it between BM25 and
vector runs, the comparison is only valid against identical corpora. Adding
or modifying beliefs changes IDF weights across all cases; verify all 60
static cases still pass after any corpus modification.

## Adding Cases

Test cases are defined in:

- `src/__fixtures__/retrieval.cases.json` — static cases
- `src/__fixtures__/session-retrieval.cases.json` — session cases

Each static case follows this structure:

```json
{
  "caseId": "your-case-id",
  "description": "What property this case verifies",
  "scope": ["domain:code"],
  "query": "the query string",
  "expect": {
    "relevantBeliefs": {
      "shouldOnlyInclude": ["b-belief-id"]
    },
    "pinnedFacts": {
      "mustInclude": ["b-pinned-id"]
    }
  }
}
```

Use `shouldOnlyInclude` to assert both precision and recall simultaneously —
the case fails if any unexpected belief is returned or any expected belief is
missing. Use `mustInclude` and `mustExclude` for partial assertions where
other beliefs may also legitimately surface.

New beliefs added to the seed corpus affect IDF weights across all cases.
Verify existing cases still pass after any corpus modification.

Session cases are not independently runnable queries. Each turn depends on
the belief state and turn history established by prior turns in the same case.
Evaluating individual turns in isolation produces meaningless results.

## Port Assignments

Each eval uses an isolated container and port to allow parallel runs:

| Eval file                               | Container name                     | Port  |
| --------------------------------------- | ---------------------------------- | ----- |
| `retrieval.eval.test.ts`                | `memory-eval-atlas`                | 27018 |
| `retrieval.vector.eval.test.ts`         | `memory-eval-atlas-vector`         | 27019 |
| `session-retrieval.test.ts`             | `memory-eval-session-atlas`        | 27020 |
| `session-retrieval.vector.eval.test.ts` | `memory-eval-session-atlas-vector` | 27021 |

If a previous run was interrupted and left a container running, remove it
manually before re-running:

```bash
docker rm -f memory-eval-atlas
```

## Relationship to the Paper

The eval suite is the quantitative anchor for the claims in _Beyond Similarity
Search: Tenure and the Case for Structured Belief State in LLM Memory_. The
72 cases correspond directly to the case categories described in Section 6.2
of the paper. The drift score metric is defined in Section 6.3. The
clause-level score attribution in `searchScores` is the observability property
described in Section 5.4.

The suite is designed to be reusable. Any system claiming comparable retrieval
properties can be measured against the same 72 cases by implementing the
`searchText` interface and running against the same seed corpus.

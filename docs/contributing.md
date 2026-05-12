# Contributing to Tenure

Tenure is early and the surface area is intentionally small. The best contributions right now are:

- Retrieval gaps documented as failing eval cases
- Provider compatibility fixes
- Client setup guides for clients not yet in [docs/clients.md](docs/clients.md)
- Bug reports with reproduction steps

---

## Design Principles

- **Conservative writes, liberal reads.** When extraction signals disagree, don't write. When assembling context, include generously.
- **No temporal decay.** Beliefs don't weaken with age. They remain active until explicitly superseded.
- **Compaction is a view, not a write.** Raw history is always preserved; the compacted window is computed on read.
- **Beliefs are never deleted.** Superseded beliefs are marked and retained. The full mutation arc is always auditable.
- **Extraction never blocks responses.** The worker runs asynchronously; your session is never held waiting for belief writes.
- **No hardcoded model lists.** `/v1/models` queries upstream providers directly.

---

## Getting Started

```bash
git clone https://github.com/jeffreyflynt/tenure
cd tenure
npm install
cp .env.example .env   # add your provider keys
npm run dev
```

Tests require Docker for the Atlas Local container:

```bash
npm test                  # unit + integration
npm run test:eval         # retrieval eval suite (~90s first run)
```

---

## How to Contribute a Retrieval Fix

The retrieval eval suite in `src/retrieval/retrieval.cases.json` is the most
direct way to contribute. If you find a case where Tenure surfaces the wrong
belief or misses one you'd expect:

1. Add a failing case to `retrieval.cases.json` with `shouldOnlyInclude`,
   `mustExclude`, or `orderedBefore` assertions and a `notes` field explaining
   what the correct behavior should be
2. Open a PR with just the failing case. A fix is welcome but not required
3. If you have a fix, include it alongside the case so the suite passes

This is the lowest-friction contribution path. A well-described failing case
is as valuable as a fix because it documents a known blind spot precisely.
See [docs/retrieval-eval.md](docs/retrieval-eval.md) for how the suite works.

---

## Areas That Need Help

| Area                      | What's needed                                                     |
| ------------------------- | ----------------------------------------------------------------- |
| Retrieval edge cases      | Failing eval cases for gaps you encounter                         |
| Provider compatibility    | Fixes or notes for providers not in the tier table                |
| Client setup guides       | Step-by-step for clients not yet in docs/clients.md               |
| Extraction quality        | Cases where the wrong belief was written or a good one was missed |
| Compaction behavior       | Cases where a turn was collapsed when it shouldn't have been      |
| Direct Anthropic provider | Verify extraction and streaming work correctly                    |
|                           | with a direct Anthropic API key and report results                |

---

## What We're Not Looking For Right Now

- Multi-user support: on the roadmap but the architecture needs to land first
- Alternative storage backends: MongoDB Atlas Local is load-bearing
- UI framework rewrites: the current HTML/JS is intentional for the scope

---

## Submitting a PR

- Keep PRs focused — one fix or one feature per PR
- If you're changing extraction behavior, include a test case
- If you're changing retrieval behavior, include an eval case
- The design principles above are the bar for architectural changes; if a change conflicts with one of them, explain why in the PR description

---

## Questions

Open an issue. If you're unsure whether something is a bug or intended behavior, open an issue before writing code.

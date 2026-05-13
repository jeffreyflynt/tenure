# Tenure: Local Long-Term Memory for Open WebUI, LM Studio, and Any OpenAI-Compatible Client

![Build](https://github.com/jeffreyflynt/tenure/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)
![arXiv](https://img.shields.io/badge/arXiv-2605.11325-b31b1b.svg)

_Stop briefing strangers. Start working with a model that already knows your work._

Tenure is a local, privacy-first proxy that builds a structured world model of your preferences, decisions, and expertise, injecting the right context into every session
automatically. Point any OpenAI-compatible client at `localhost:5757` and every response is already contextualized. Your client doesn't know Tenure exists.

- **Zero Configuration**: Drop-in OpenAI API compatibility.
- **Local-First**: Your memory stays on your machine, no cloud, no tracking.
- **Beyond RAG**: Similarity search returns everything in the neighborhood because your beliefs genuinely are semantically related. Tenure uses alias-weighted term matching that returns exactly what you named, not everything nearby.

## Features

- **Zero re-briefing**: Your stack, decisions, and preferences carry forward automatically. Tenure ensures every new session already knows your work, eliminating the "Monday morning" context reset.
- **Instant import**: Drop in an existing skills file, bio, or notes doc and Tenure seeds your world model immediately, no cold start, no manual entry.
- **Transparent to your tools**: Point any OpenAI-compatible client at `localhost:5757/v1` and it works; no plugins, no custom integrations. The client doesn't know Tenure exists.
- **Structured beliefs, not transcript dumps**: Organizes what it knows about you into Preferences, Decisions, Entities, Open Questions, and Expertise. Injects a curated slice per session, not raw history. Stays fast and cheap at scale.
- **Full control**: Every belief is visible, editable, and auditable at `/beliefs`. Pin what matters, correct what's wrong. Pause extraction globally from Settings, or per-session with `!extract off` directly in your chat client, without leaving your workflow.
- **Compaction you can tune**: History and belief compaction run automatically, with aggressive, conservative, and off modes configurable from the admin UI.
- **Private and local**: Runs entirely on your machine. Your context never leaves `localhost`. Belief content is encrypted at rest. See [docs/security.md](docs/security.md).
- **Portable**: Export your entire world model as a passphrase-encrypted archive and restore it on any machine.
- **Provider agnostic**: Routes to any OpenAI-compatible endpoint: GPT-4o, Claude, Bedrock, LiteLLM, with prompt caching where supported.

## The Problem

Every new LLM session starts from zero. You re-explain your stack, restate your voice, re-establish decisions you made weeks ago. The model meets you as a stranger every time. And when you don't re-explain, when you just ask the question, this is what you get.

A developer had already established in a prior session: TypeScript, Fastify, MongoDB, raw driver only, no ORMs, composition over inheritance. In a new session they asked:

> _How should I structure my repository layer?_

The response was 200 lines of Python using SQLAlchemy:

```python
class SQLUserRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def get_by_id(self, user_id: int) -> User | None:
        return self._session.get(User, user_id)
```

Wrong language. Wrong database. Wrong paradigm. And now the next prompt has to be a correction instead of progress.

With Tenure, the same question in a new session, cold start, produced this:

```typescript
export function makeUserRepository(db: Db): UserRepository {
  const col: Collection<UserDoc> = db.collection("users");

  return {
    async findById(id, ctx) {
      const doc = await col.findOne(
        { _id: new ObjectId(id) },
        { session: ctx?.session },
      );
      return doc ? toUser(doc) : null;
    },
    async insert(data, ctx) {
      const doc: UserDoc = {
        _id: new ObjectId(),
        ...data,
        createdAt: new Date(),
      };
      await col.insertOne(doc, { session: ctx?.session });
      return toUser(doc);
    },
  };
}
```

TypeScript. MongoDB raw driver. Factory function returning a plain object. Session threading via optional `ctx` argument. No re-explanation required, because those preferences were already in the world model.

The same problem applies to every iterative, session-heavy workflow. A writer shouldn't re-explain a character's voice in session four. A researcher shouldn't re-litigate a ruled-out approach. The model should already know.

## Who This Is For

Tenure is for anyone whose work compounds across sessions, because what you ruled out last week matters as much as what you decided this morning.

- **Engineers**: No more re-explaining that you hate ORMs, use Vitest, and prefer explicit error returns over exceptions.
- **Data Scientists**: Keep modeling decisions, ruled-out approaches, and dataset quirks in context across every experiment.
- **Writers**: Keep character voices, world bibles, and open plot threads consistent across every session.
- **Students & Researchers**: Never re-establish your thesis angle, ruled-out sources, or advisor feedback from scratch mid-project.
- **Consultants**: Switch cleanly between client contexts, stack preferences, tone guides, and standing decisions, without re-briefing from scratch.

Works with chat clients, IDEs, and manual mode. See [docs/clients.md](docs/clients.md) for setup by client type.

## Quick Start

See [docs/quickstart.md](docs/quickstart.md) for full setup instructions. The short version:

1. **Install and start Tenure**

   **Linux / macOS:**

   ```bash
   curl -fsSL https://raw.githubusercontent.com/jeffreyflynt/tenure/main/scripts/install.sh | bash
   ```

   **Windows (PowerShell):**

   ```powershell
   irm https://raw.githubusercontent.com/jeffreyflynt/tenure/main/scripts/install.ps1 | iex
   ```

   Your API token is printed to the terminal on first start and saved to `~/.tenure/token`.

2. **Complete setup.** Open [http://localhost:5757/onboarding](http://localhost:5757/onboarding) in your browser. Connect a provider, pick a default model, and answer a few questions to seed your world model. See [docs/quickstart.md](docs/quickstart.md) for import and cold-start options.

3. **Point your client** at `http://localhost:5757/v1` with your bearer token. Open [http://localhost:5757/beliefs](http://localhost:5757/beliefs) to view and manage your world model.

## How It Works

Tenure sits between any OpenAI-compatible client and upstream LLM providers. On every request:

1. Assembles a **belief context**: a curated slice of your world model, budgeted within a token ceiling
2. Injects both into the system prompt alongside a sidecar instruction, a structured metadata block the model writes back, which Tenure strips before returning the response to your client
3. Forwards the call to the resolved provider (streaming or non-streaming)
4. Returns a standard OpenAI-format response, so the client sees no difference

Context assembly is local and fast. The belief extraction worker runs asynchronously after the response is returned, so it never blocks your session.

### Why curated beliefs, not conversation history

The naive approach is injecting raw conversation history into each new
session. Tenure doesn't do this.

Raw history grows linearly and gets injected on every turn. Dropping a
transcript into context also asks the model to read it, infer what matters,
and apply it to the current question, work that competes with the task at
hand. Tenure extracts conclusions at write time, when the model already knows
why something was decided. The model receives structured beliefs it can act
on directly, not raw material to process first.

Retrieval works the same way. Your stack lives in a semantically related
neighborhood: Redis, TypeScript, Fastify, MongoDB all score similarly against
each other because they genuinely are related. Similarity search returns
everything at similar scores. Tenure uses alias-weighted term matching that
returns exactly what you named, not everything nearby.

Rejected alternatives are indexed too. Ask about Mongoose and Tenure surfaces
your MongoDB raw driver decision, because what you ruled out is a query path
to what you actually use.

### Mid-session changes

When you change direction mid-session, say "actually, let's switch to Postgres" or "I've decided the narrator is unreliable", Tenure handles it in two layers. Within the session, your last several turns are always injected in full so the model sees what you just said immediately. Between sessions, the extraction worker has already superseded the old belief and written the new one before your next conversation starts.

### Supported models

Belief extraction requires reliable structured output. Smaller or heavily quantized models won't produce the consistency the extraction worker needs.

| Family          | Floor                          | Status    |
| --------------- | ------------------------------ | --------- |
| Claude          | 4.5 and above                  | Community |
| GPT             | GPT-4o-mini and above          | Community |
| OpenAI o-series | o3, o4-mini and above          | Community |
| Bedrock Claude  | Anthropic Claude 4.5 and above | Verified  |
| Bedrock Nova    | Amazon Nova Pro                | Community |

Any OpenAI-compatible endpoint serving one of these models works, including Bedrock gateways, LiteLLM, and similar setups.

## Your World Model

Beliefs are organized into types: **Preferences**, **Decisions**, **Entities**, **Relations**, and **Open Questions**. Preferences carry an optional subtype: **Expertise** (depth calibration) or **Style** (communication patterns). They're scoped by domain, so your engineering preferences don't bleed into creative sessions.

Every belief carries a `why_it_matters` field: not just "uses TypeScript with strict mode" but "shapes all code examples toward TypeScript with strict mode
and no implicit any." The model receives instructions it can act on directly, not facts it has to figure out how to apply.

Every belief is visible, editable, and auditable at `/beliefs`. See [docs/beliefs.md](docs/beliefs.md) for the full walkthrough.

### Scoped context, no bleed

Beliefs are organized into a three-level hierarchy:

- **Universal** — communication style, how you want to be engaged. Surfaces everywhere.
- **Domain** — how you work within a discipline (`domain:code`, `domain:writing`, `domain:teaching`). Your TypeScript error handling preference stays out of your novel sessions.
- **Project** — facts specific to a named project. Your API's database choice doesn't bleed into your side project.

Sub-domains narrow further when you need them: `domain:code/typescript` applies to all TypeScript work but not Python, while still surfacing in a general code session.

Tenure sets your scope automatically from your first message. You can also set it explicitly:

```
!scope domain:writing
!scope domain:code/typescript
```

Without scope, Tenure still works — it just retrieves across all your beliefs, which can introduce noise when your domains are very different from each other.

To pause extraction for a session without opening Settings:

```
!extract off          ← stops recording this session
!extract on           ← resumes
!extract global off   ← pauses everywhere
```

## Token Efficiency

Tenure reduces token costs in two directions. On the supply side, the belief store stays compact through continuous compaction, beliefs are retrieved selectively rather than injected in full, and prompt caching on the static and belief tiers means you pay for context injection once per session. On the demand side, a model that knows to ask before executing (because that preference is in your world model) prevents the most expensive failure mode: a long, confident response that went the wrong direction. A two-sentence clarifying question that costs 50 tokens and prevents a 5,000-token miss is a 99% reduction on that exchange.

The system prompt is long by design: each instruction is written out explicitly
so the model does not need to reason over it, protecting reasoning tokens for
the actual task. Prompt caching means that length is paid for once per session
rather than on every turn. See [docs/prompt-caching.md](docs/prompt-caching.md)
for details on minimum token thresholds and how the static and belief tiers are
structured to meet them.

## Reproducing the Evaluation

The retrieval claims in the paper are reproducible from the repo.
See [docs/eval.md](docs/eval.md) for instructions. Both backends
run against the same committed seed corpus; Docker is the only
prerequisite for the BM25 evaluation.

## Tradeoffs

Tenure is conservative by design. It would rather surface nothing than surface the wrong thing. Retrieval quality improves over time because every session teaches the system
new ways you refer to things. Call your cat "my baby" once and that phrase resolves to the right belief next time. The longer you use it, the more precisely it finds what you mean. If a belief isn't surfacing when you'd expect it, pinning it is the most direct fix. See [docs/retrieval.md](docs/retrieval.md) for a full account of how retrieval works and how to get the most out of it. See [docs/compaction.md](docs/compaction.md) for compaction modes and how to configure them.

The ramp depends on how you start. Import an existing skills file or run onboarding and the first session is already informed. Starting cold, the model builds your world model from extraction over time; the first session will be good, the tenth noticeably better, the fiftieth will feel like working with someone who actually knows you.

Multi-user support and belief sharing across users are not yet implemented. See [docs/roadmap.md](docs/roadmap.md) for what's coming.

## Contributing

See [docs/contributing.md](docs/contributing.md).

## License

MIT

```

```

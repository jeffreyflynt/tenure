# Tenure: Local Long-Term Memory for Any OpenAI-Compatible Client

![Build](https://github.com/jeffreyflynt/tenure/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)
![arXiv](https://img.shields.io/badge/arXiv-2605.11325-b31b1b.svg)

You explain something to one person and it goes right over their head. Same thing, different person, clicks instantly. The difference isn't the information. It's knowing how someone hears things.

Your AI has the same problem. It doesn't fail because it lacks information. It fails because it doesn't know how to reach _you_, how you process decisions, what kind of answer actually lands, what you've already ruled out and why.

Tenure fixes that. It's a local proxy that learns how you think, what you've decided, and how you want to be spoken to, then brings that into every session automatically. Point any OpenAI-compatible client at `localhost:5757` and every response is already yours. Your client doesn't know Tenure exists.

New install? Start here: [Quickstart](docs/quickstart.md)

## The Problem

Every new session starts from zero. You re-explain your stack, restate your voice, re-establish decisions you made weeks ago. And when you don't re-explain, when you just ask the question, this is what you get.

A developer had already established: TypeScript, Fastify, MongoDB, raw driver, composition over inheritance. New session, they asked:

> _How should I structure my repo?_

200 lines of Python using SQLAlchemy. Wrong language. Wrong database. Wrong paradigm. The next prompt becomes a correction instead of progress.

With Tenure running, same question, cold start, new session:

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

TypeScript. MongoDB raw driver. Factory function. No re-explanation required because those preferences were already in the world model.

This isn't just a developer problem. A writer shouldn't re-explain a character's voice in session four. A researcher shouldn't re-litigate a ruled-out approach. A consultant switching between clients shouldn't re-brief from scratch. The model should already know.

## Why This Is Different

Most memory tools are glorified search. They store what you said and retrieve what sounds similar. That's not memory, it's a transcript with a search bar. The model still has to read it, infer what matters, and figure out how to apply it, competing with the actual task at hand.

Tenure doesn't retrieve. It instructs.

Every observation is converted into a structured belief with a `why_it_matters` field: not just "uses TypeScript with strict mode" but "shapes all code examples toward TypeScript with strict mode and no implicit any." The model receives instructions it can act on directly, not raw material to process first.

**It knows what you ruled out, not just what you chose.** Rejected alternatives are indexed too. Ask about Mongoose and Tenure surfaces your MongoDB raw driver decision, because what you ruled out is a query path to what you actually use. It doesn't just know you chose MongoDB, it knows why you rejected Mongoose, so it never suggests it again.

**It retrieves what applies, not what's similar.** Your stack lives in a semantic neighborhood: Redis, TypeScript, Fastify, MongoDB all score similarly against each other. Similarity search returns everything nearby. Tenure uses alias-weighted term matching that returns exactly the belief that matches what you're actually asking about, not everything in the neighborhood.

**It learns how you refer to things.** Call your cat "my baby" once and that phrase resolves correctly next time. The longer you use it, the more precisely it finds what you mean.

**It knows how to talk to you.** Not just your preferences, but your communication patterns, whether you want clarifying questions before long responses, whether you process tradeoffs first or conclusions first. The same information, delivered the way it actually lands for you.

**It catches up mid-session.** Say "actually, let's switch to Postgres" and Tenure handles it in two layers: your recent turns are always injected in full so the model sees the change immediately, and the extraction worker supersedes the old belief before your next session starts.

## Who This Is For

Tenure is for anyone whose work compounds across sessions, because what you ruled out last week matters as much as what you decided this morning.

- **Engineers**: Stop re-explaining that you hate ORMs, use Vitest, and prefer explicit error returns over exceptions.
- **Writers**: Character voices, world bibles, and open plot threads stay consistent across every session.
- **Data Scientists**: Modeling decisions, ruled-out approaches, and dataset quirks persist across every experiment.
- **Students & Researchers**: Your thesis angle, ruled-out sources, and advisor feedback don't reset mid-project.
- **Consultants**: Switch cleanly between client contexts without re-briefing from scratch.

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

2. **Complete setup.** Open [http://localhost:5757/onboarding](http://localhost:5757/onboarding) in your browser. Connect a provider, pick a default model, and answer a few questions to seed your world model.

3. **Point your client** at `http://localhost:5757/v1` with your bearer token. Open [http://localhost:5757/beliefs](http://localhost:5757/beliefs) to view and manage your world model.

## Trust and Ownership

- **Fully local.** Runs entirely on your machine. Your context never leaves `localhost`.
- **Encrypted at rest.** Belief content is encrypted. See [docs/security.md](docs/security.md).
- **No hidden profiles.** Every belief is visible, editable, and correctable at `/beliefs`. Pin what matters, correct what's wrong.
- **Portable.** Export your entire world model as a passphrase-encrypted archive and restore it on any machine.
- **Pausable.** Stop extraction globally from Settings, or per-session with `!extract off` directly in your chat.

## How It Works

Tenure sits between your client and any upstream LLM provider. On every request:

1. Assembles a **belief context**: a curated slice of your world model, budgeted within a token ceiling
2. Injects it into the system prompt alongside a sidecar instruction, a structured metadata block the model writes back, which Tenure strips before returning the response to your client
3. Forwards the call to the resolved provider (streaming or non-streaming)
4. Returns a standard OpenAI-format response, the client sees no difference

Context assembly is local and fast. The belief extraction worker runs asynchronously after the response, so it never blocks your session.

### Your world model

Beliefs are organized into types: **Preferences**, **Decisions**, **Entities**, **Relations**, and **Open Questions**. Preferences carry an optional subtype: **Expertise** (depth calibration) or **Style** (communication patterns), and are scoped by domain so your engineering preferences don't bleed into creative sessions.

Scoping is a three-level hierarchy:

- **Universal** - communication style and engagement preferences. Surfaces everywhere.
- **Domain** - how you work within a discipline (`domain:code`, `domain:writing`). Sub-domains narrow further: `domain:code/typescript` applies to all TypeScript work but not Python.
- **Project** - facts specific to a named project. Your API's database choice doesn't bleed into your side project.

Tenure sets scope automatically from your first message. You can also set it explicitly:

```
!scope domain:writing
!scope domain:code/typescript
```

To pause extraction for a session without opening Settings:

```
!extract off          ← stops recording this session
!extract on           ← resumes
!extract global off   ← pauses everywhere
```

See [docs/beliefs.md](docs/beliefs.md) for the full walkthrough.

### Token efficiency

Tenure reduces token costs in two directions. On the supply side, beliefs are retrieved selectively, the belief store stays compact through continuous compaction, and prompt caching on the static and belief tiers means you pay for context injection once per session. On the demand side, a model that already knows to ask before executing prevents the most expensive failure mode: a long, confident response that went the wrong direction. A two-sentence clarifying question that costs 50 tokens and prevents a 5,000-token miss is a 99% reduction on that exchange.

See [docs/prompt-caching.md](docs/prompt-caching.md) for details.

### Supported models

Belief extraction requires reliable structured output. Smaller or heavily quantized models won't produce the consistency the extraction worker needs.

| Family          | Floor                                               | Status    |
| --------------- | --------------------------------------------------- | --------- |
| Claude          | 4.5 and above                                       | Community |
| GPT             | GPT-4o-mini, GPT-4.1-mini, and above                | Community |
| OpenAI o-series | o3, o4-mini and above                               | Community |
| Bedrock Claude  | Anthropic Claude 4.5 and above                      | Verified  |
| Bedrock Nova    | Nova Pro, Nova 2, Nova Premier (Nova Lite excluded) | Community |
| Bedrock GPT-OSS | GPT-OSS 120B only (20B excluded)                    | Community |
| Bedrock Mistral | Mistral Large 3 (675B) only                         | Community |
| Qwen3           | Qwen3-235B-A22B-2507 and above                      | Community |

Any OpenAI-compatible endpoint serving one of these models works, including Bedrock gateways, LiteLLM, and similar setups.

A note on floors: exclusions are deliberate. GPT-OSS 20B, Nova Lite, Ministral, and smaller Qwen3 variants pass format checks but produce insufficient extraction quality for Tenure's sidecar schema. When in doubt, use a verified or larger community model.

## Tradeoffs and The Ramp

Tenure is conservative by design. It would rather surface nothing than surface the wrong thing. If a belief isn't surfacing when you'd expect it, pinning it is the most direct fix. Retrieval quality improves over time as the system learns new ways you refer to things. See [docs/retrieval.md](docs/retrieval.md) for how retrieval works and how to get the most out of it.

The ramp depends on how you start. Import an existing skills file or run onboarding and the first session is already informed. Starting cold: the first session will be good, the tenth noticeably better, the fiftieth will feel like working with someone who actually knows you.

Multi-user support and belief sharing are not yet implemented. See [docs/roadmap.md](docs/roadmap.md) for what's coming.

## Reproducing the Evaluation

The retrieval claims in the paper are reproducible from the repo. See [docs/eval.md](docs/eval.md) for instructions. Docker is the only prerequisite for the BM25 evaluation.

## Contributing

See [docs/contributing.md](docs/contributing.md).

## License

MIT

Persistent AI memory that follows you across every tool, session, and interface. Fully local.

![Build](https://github.com/tenurehq/tenure/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)
![arXiv](https://img.shields.io/badge/arXiv-2605.11325-b31b1b.svg)

---

Every AI session starts from zero. You re-explain your stack. You restate your voice. You re-establish decisions you made weeks ago. And when you don't re-explain, when you just ask the question, you get a confident, detailed answer that completely misses the point.

A developer had already established: TypeScript, Fastify, MongoDB, raw driver, composition over inheritance. New session, they asked:

> _How should I structure my repo?_

200 lines of Python using SQLAlchemy. Wrong language. Wrong database. Wrong paradigm.

The next prompt becomes a correction instead of progress.

## What Tenure does

You spend an hour in a chat interface thinking through an architecture problem. You explore options, rule some out, land on a direction. Then you open your IDE to start building.

Tenure is already there. It knows what you decided, what you rejected, and why. You don't re-explain anything. You just build.

It sits between your clients and your AI provider and quietly learns from your conversations. Every tool that routes through it shares the same belief store, so context you establish in one place is already present when you switch to another.

Same question, cold start, new session, with Tenure running:

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

TypeScript. MongoDB raw driver. Factory function. No re-explanation required.

## What actually goes wrong without it

Memory problems don't always announce themselves. They show up as wasted cycles.

**Old decisions resurface as suggestions.** You switched from Jest to Vitest three months ago. The model recommends Jest. You correct it. You move on. It happens again next week.

**Ruled-out approaches keep coming back.** You evaluated Mongoose, decided against it, and explained why. Without memory of that decision, it will be suggested again. And again.

**Context resets mid-project.** A writer shouldn't re-explain a character's voice in session four. A researcher shouldn't re-litigate a ruled-out approach. A consultant switching between clients shouldn't re-brief from scratch.

**Different tools behave differently.** You establish preferences in one client. A second client starts cold. Your tools give inconsistent answers to the same question.

Tenure addresses all of these by keeping a structured, evolving model of how you work, across sessions, across clients, across time.

## Who it's for

Tenure is for anyone whose work compounds across sessions.

**Engineers** -- stop re-explaining that you hate ORMs, use Vitest, and prefer explicit error returns over exceptions.

**Writers** -- character voices, world details, and open plot threads stay consistent across every session.

**Researchers** -- your thesis angle, ruled-out sources, and advisor feedback don't reset mid-project.

**Consultants** -- switch cleanly between client contexts without re-briefing from scratch.

## Works where you already work

Any OpenAI-compatible client works out of the box. Point it at `http://localhost:5757/v1` and it routes through Tenure automatically.

Native integrations are available for [OpenClaw](docs/clients.md#openclaw) and [VS Code](docs/clients.md#vs-code). Open WebUI and most other chat interfaces work without any integration. See [docs/clients.md](docs/clients.md) for the full list and setup instructions.

## Get started

**Linux / macOS:**

```bash
curl -fsSL https://raw.githubusercontent.com/tenurehq/tenure/main/scripts/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/tenurehq/tenure/main/scripts/install.ps1 | iex
```

After install, open [http://localhost:5757/onboarding](http://localhost:5757/onboarding) to connect a provider, pick a model, and answer a few questions to seed your memory. Then point your client at `http://localhost:5757/v1` with your bearer token.

Full instructions: [docs/quickstart.md](docs/quickstart.md)

## Private by design

Everything runs on your machine. Your context never leaves localhost. Belief content is encrypted at rest. Every memory is visible, editable, and correctable at `/beliefs`. Nothing is hidden. You can export your entire memory as an encrypted archive and restore it on any machine.

To pause memory for a session, type `!extract off` in your chat.

Details: [docs/security.md](docs/security.md)

## The ramp

The first session will be good. The tenth noticeably better. By the fiftieth, it feels like working with someone who actually knows you.

If you import an existing preferences file or complete onboarding, the first session is already informed. Starting cold, Tenure learns from every exchange and gets more precise over time.

More on how retrieval works and how to get the most out of it: [docs/retrieval.md](docs/retrieval.md)

## Further reading

- [How memory is structured](docs/beliefs.md)
- [Supported models](docs/models.md)
- [Prompt caching and token efficiency](docs/prompt-caching.md)
- [Retrieval details](docs/retrieval.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](docs/contributing.md)

## License

MIT

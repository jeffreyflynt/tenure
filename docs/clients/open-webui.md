# Tenure + Open WebUI: Persistent Memory Across Every Session

Open WebUI is where Tenure does its best work. It's a conversational interface (the place where you reason, decide, and refine), which means every session generates the kind of signal Tenure learns from. Point Open WebUI at Tenure's proxy and you get persistent memory with no plugins, no workflow changes, and nothing visible on the client side.

---

## What This Gives You

Without Tenure, every Open WebUI session starts from zero. You re-explain your stack. You restate preferences the model acted on perfectly last week. You re-litigate decisions that are already settled.

With Tenure running as the proxy, Open WebUI sessions are already contextualized before your first message. Your preferences, decisions, entities, and open questions are injected into the system prompt on every request. The model meets you where you left off.

This is not RAG over your chat history. Tenure extracts structured beliefs from your conversations and injects curated conclusions, not raw transcripts. The model receives things it can act on directly, not material it has to process first.

---

## Setup

**Prerequisites:** Tenure running locally. If you haven't installed it yet, see [quickstart.md](quickstart.md). Your bearer token is in `~/.tenure/token` (Linux/macOS) or `%USERPROFILE%\.tenure\token` (Windows), or printed at the end of installation.

**In Open WebUI:**

1. Go to **Settings → Admin Panel → Connections** (or **Settings → Connections** depending on your version)
2. Under **OpenAI API**, set the base URL to:
   ```
   http://localhost:5757/v1
   ```
3. Set the API key to your Tenure bearer token
4. Save and reload the model list

Open WebUI will now show all models from your configured upstream provider, routed through Tenure.

**Docker networking note:** If Open WebUI is itself running in Docker, `localhost` won't resolve to your host machine. Use `http://host.docker.internal:5757/v1` instead (Docker Desktop on Mac/Windows) or your host's LAN IP on Linux.

---

## How the Memory Loop Works

Open WebUI is a full read/write client for Tenure. Every conversation both reads from and writes to your world model.

**On each request**, Tenure:

1. Assembles a belief context: a curated slice of your world model within a token budget
2. Retrieves relevant beliefs from your world model via alias-weighted text search
3. Injects both into the system prompt before forwarding to your upstream provider
4. Returns a standard OpenAI-format response. Open WebUI sees nothing unusual

**After each response**, Tenure's extraction worker runs asynchronously, reading the exchange and updating your world model with anything new: preferences surfaced, decisions made, entities mentioned, questions opened or closed. This never blocks your session.

Your world model grows with every conversation. The first session will be good. The tenth will be noticeably better.

---

## Viewing and Editing Your World Model

Open [http://localhost:5757/beliefs](http://localhost:5757/beliefs) to see what Tenure has learned about you. Beliefs are organized into five types:

- **Preferences:** how you work and communicate (with subtypes for expertise and style)
- **Decisions:** commitments future sessions must respect
- **Entities:** named things in your world: characters, services, systems, people
- **Relations:** connections between entities
- **Open Questions:** things you are still working through

You can edit any belief, add your own, or pin a belief to ensure it's always injected regardless of retrieval scoring. If Tenure learned something wrong, fix it at `/beliefs` and it stops injecting immediately.

---

## Switching Between Contexts

Beliefs are scoped by domain. If you use Open WebUI for both engineering work and creative writing, your TypeScript conventions won't bleed into a fiction session. Tenure keeps belief sets separate so each context gets exactly what's relevant.

---

## Onboarding

If this is your first time running Tenure, open [http://localhost:5757/onboarding](http://localhost:5757/onboarding) before your first session. Onboarding lets you connect a provider, select a default model, and seed your world model with a few direct answers. It's optional. Tenure will build your world model from extraction alone if you skip it, but onboarding shortens the ramp considerably.

---

## Troubleshooting

**Models aren't showing up in Open WebUI**
Confirm Tenure is running (`docker compose -f ~/.tenure/docker-compose.yml ps`) and that the base URL is set correctly. If Open WebUI is in Docker, check the networking note above.

**Responses don't seem context-aware in early sessions**
This is expected. Tenure's retrieval improves as the belief store grows. If a specific belief isn't surfacing, pin it at `/beliefs`.

**I want to use a session without Tenure extracting from it**
Pass the header `X-Tenure-No-Extract: true` on the request, or disable extraction globally at **Admin Panel → Settings → Extraction**.

---

## Related

- [Quickstart](quickstart.md): installation instructions
- [Beliefs](beliefs.md): how the world model works and how to get the most from it
- [Retrieval](retrieval.md): how context is selected and how to influence it
- [Providers](providers.md): connecting GPT-4o, Claude, Bedrock, and others
- [Client Setup](clients.md): setup guides for other clients

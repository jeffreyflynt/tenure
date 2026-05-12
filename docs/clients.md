# Client Setup

Tenure works with any OpenAI-compatible client. Point it at `http://localhost:5757/v1` with your bearer token and it works transparently. (If you changed the port via `TENURE_PORT`, substitute accordingly.)

> **Docker networking note:** If your client is itself running in Docker, `localhost` won't resolve to your host machine. Use `http://host.docker.internal:5757/v1` instead (Docker Desktop on Mac/Windows) or your host's LAN IP on Linux.

## Chat clients (fully supported)

Open WebUI, LibreChat, Onyx, and similar conversational interfaces are where Tenure does its best work. This is where reasoning happens: where you brainstorm, decide, and refine. Tenure reads every exchange, extracts beliefs, and builds your world model from that signal. These clients both read from and write to memory.

**Setup:** In your client's API settings, set the base URL to `http://localhost:5757/v1` and paste your bearer token. Select any model from the list and start chatting.

For Open WebUI-specific setup, see [open-webui.md](open-webui.md).

## IDE clients (read-only)

Cursor, Windsurf, and similar coding tools connect through Tenure and receive a memory-informed model for free. Your preferences are injected into every coding session without extra setup.

IDE traffic is predominantly code operations rather than conversational reasoning, so Tenure does not extract beliefs from it. The right pattern: build your world model through chat, apply it everywhere else. That is an intentional contract, not a gap.

**Setup:** In your IDE's AI settings, replace the OpenAI base URL with `http://localhost:5757/v1` and add your bearer token.

## Manual mode

If you prefer to manage your world model by hand, extraction can be disabled entirely. Tenure still injects whatever you have authored into every session.

To disable extraction globally: **Admin Panel → Settings → Extraction → Enabled: off**

Per-session disable is also supported via a request header: `X-Tenure-No-Extract: true`

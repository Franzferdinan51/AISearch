# Lumen AI Search

Lumen is a local-first AI search and deep-research workspace. It uses SearXNG for bounded web retrieval, an OpenAI-compatible model contract for synthesis, LM Studio as a first-class local runtime, and local CLI OAuth sessions for OpenAI, MiniMax, and Grok.

## Run locally

```bash
npm install
cp .env.example .env
npm run searxng
npm run dev:api
npm run dev
```

The browser runs on Vite and proxies `/api` to the local orchestration API. The API defaults to `127.0.0.1:8787`; set `LUMEN_API_PORT` if another local service already owns that port, and start Vite with the same variable.

SearXNG must allow JSON output and respond at `/search?format=json`. The deep-research route is bounded to three focused queries, deduplicates URLs, caches results for five minutes, caps results per query, and reads the top four HTML source pages with timeouts before synthesis. Quick web search stays snippet-first and does not crawl pages.

`npm run searxng` starts the bundled SearXNG container on `http://127.0.0.1:8080`. Lumen returns normal web pages, documentation, GitHub repositories, news, and other engine results from SearXNG; it does not restrict retrieval to academic sources.

For a production-like local stack, run `docker compose up --build`. Lumen is served at `http://127.0.0.1:3000` and reaches the bundled SearXNG service over the private Compose network.

## Provider and OAuth model

Remote API keys stay on the server in `.env`; they are never sent to the browser. LM Studio uses its local OpenAI-compatible endpoint and can run without a token. OAuth status and login routes invoke the configured local CLI (`codex`, `mmx`, or `grok`) and return only install/auth state, following the local-session approach used by [Prediction](https://github.com/Franzferdinan51/Prediction). When a remote provider has an authenticated local session, `/api/research` uses that CLI for synthesis without copying credentials into Lumen or the browser; a configured OpenAI-compatible endpoint remains the fallback.

The bridge follows the installed CLI contracts: `codex login`, `mmx auth login`, and `grok login --oauth`; Grok auth status is checked with `grok models`. Set `OPENAI_CODEX_MODEL` only if the installed Codex build exposes a compatible ChatGPT OAuth model.

Useful API routes:

- `GET /api/health`
- `POST /api/search` with `{ "query", "depth": "quick" | "deep", "maxResults" }`
- `POST /api/research` with `{ "query", "provider" }`
- `GET /api/cli-auth/:provider`
- `POST /api/cli-auth/:provider/login`
- `GET /api/agents`
- `POST /api/agent/openclaw` or `/api/agent/hermes` with `{ "prompt" }`

Agent connector calls are bounded one-shot local subprocesses. OpenClaw is invoked without `--deliver`, so research cannot silently publish to an external channel.

The product direction is informed by [SearXNG](https://github.com/searxng/searxng) and [Vane](https://github.com/ItzCrazyKns/Vane): privacy-preserving metasearch, source citations, bounded research, local history, and interchangeable local/cloud model connections.

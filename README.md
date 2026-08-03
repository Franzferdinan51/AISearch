# Lumen AI Search

Lumen is a local-first AI web search and deep-research workspace. It uses SearXNG for website retrieval and scoped search, AI ranking for tailored results, LM Studio as a first-class local runtime, and local CLI OAuth sessions for OpenAI, MiniMax, and Grok.

## What it does

- Searches websites rather than only research papers, with Web, News, Images, Videos, GitHub, and Academic scopes.
- Produces an AI overview with an expand/collapse control, then shows individually ranked website results with a tailored relevance reason.
- Provides visible pagination: page 2 shows the next result set rather than hiding it below the follow-up composer.
- Runs deep research with the selected model as an active agent: it plans a focused web query, ranks every retrieved result, checks extracted evidence for support and disagreement, and synthesizes inline-cited answers.
- Keeps the search and research surfaces in one graphite dark UI, with a persistent activity/progress strip and a follow-up composer.
- Lets you choose a provider and model, make it the default for new searches, and persist that default locally across reloads.
- Uses a GitHub repository-search route for the GitHub tab when SearXNG does not have a usable GitHub engine.

## Run locally

```bash
npm install
cp .env.example .env
npm run searxng
npm run dev:api
npm run dev
```

The browser runs on Vite and proxies `/api` to the local orchestration API. The API defaults to `127.0.0.1:3001`; set `LUMEN_API_PORT` if another local service already owns that port, and start Vite with the same variable.

SearXNG must allow JSON output and respond at `/search?format=json`. The deep-research route is bounded to three focused queries, deduplicates URLs, caches results for five minutes, AI-ranks the retrieved set, and reads every reachable source page with timeouts before synthesis. Quick scoped search stays snippet-first and does not crawl pages.

`npm run searxng` starts the bundled SearXNG container on `http://127.0.0.1:8080`. Lumen returns normal web pages, documentation, GitHub repositories, news, and other engine results from SearXNG; it does not restrict retrieval to academic sources.

For a production-like local stack, run `docker compose up --build`. Lumen is served at `http://127.0.0.1:3000` and reaches the bundled SearXNG service over the private Compose network.

## Providers, models, and OAuth

Remote API keys stay on the server in `.env`; they are never sent to the browser. Provider settings provide model dropdowns for every built-in provider and let you choose the default used for new searches. Saved models and defaults are stored locally in the browser.

LM Studio uses its local OpenAI-compatible endpoint. Lumen accepts either a base server URL such as `http://host:1234` or an explicit `/v1` URL, discovers installed models from the local model API, and includes a masked **Server API key** field for servers with authentication enabled. Select a model, then use **Test model connection**; a `Connected · … answered` message proves Lumen sent a real completion to it. The token is sent only to the local Lumen API for model discovery and model requests, is held for the browser session, and is never written to localStorage. `LM_API_TOKEN` remains available as a server-side default. Without a token, Lumen keeps working with other providers and displays an actionable local-only message instead of failing the page.

OAuth status and login routes invoke the configured local CLI (`codex`, `mmx`, or `grok`) and return only install/auth state, following the local-session approach used by [Prediction](https://github.com/Franzferdinan51/Prediction). When a remote provider has an authenticated local session, `/api/research` uses that CLI for synthesis without copying credentials into Lumen or the browser; a configured OpenAI-compatible endpoint remains the fallback.

The bridge follows the installed CLI contracts: `codex login`, `mmx auth login`, and `grok login --oauth`; Grok auth status is checked with `grok models`. Set `OPENAI_CODEX_MODEL` only if the installed Codex build exposes a compatible ChatGPT OAuth model.

## Settings

The **Settings** page is separate from **Providers**. It saves browser-local preferences for the default new-search mode, compact or comfortable result density, preloading ranked result tabs, and whether AI Overviews appear in general web searches. The page also links to Provider management and can clear the local search library.

## MCP and WebMCP

Lumen exposes two agent-facing search interfaces:

- A standard **stdio MCP server** with `search_web` (website, news, image, video, GitHub, and academic search) and `search_status` tools. Start Lumen first, then run `npm run mcp`. Set `LUMEN_API_URL` only when the API is not at `http://127.0.0.1:3001`.
- Browser-native **WebMCP** registration via `document.modelContext`, when supported by the browser. Its `search_lumen_web` tool returns website results from the current Lumen instance while keeping the browser page and user in the loop.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "lumen-search": {
      "command": "node",
      "args": ["/absolute/path/to/AISearch/mcp-server.mjs"],
      "env": { "LUMEN_API_URL": "http://127.0.0.1:3001" }
    }
  }
}
```

Provider dropdowns use a live account catalog whenever **Refresh available models** can authenticate to the provider’s `/v1/models` endpoint. Enter an optional account API key for that provider (or configure its server-side environment key) to load every model available to that account. LM Studio is treated the same way: its dropdown is populated only from its local server’s reported language models, including any locally installed model IDs.

Useful API routes:

- `GET /api/health`
- `POST /api/models` with `{ "provider", "endpoint", "key" }` for authenticated model discovery (the legacy `GET /api/models` route remains available without a key)
- `POST /api/search` with `{ "query", "category", "page", "provider", "providerConfig", "depth": "quick" | "deep", "maxResults" }`
- `POST /api/research` with `{ "query", "category", "provider", "providerConfig" }`
- `GET /api/cli-auth/:provider`
- `POST /api/cli-auth/:provider/login`
- `GET /api/agents`
- `POST /api/agent/openclaw` or `/api/agent/hermes` with `{ "prompt" }`

Agent connector calls are bounded one-shot local subprocesses. OpenClaw is invoked without `--deliver`, so research cannot silently publish to an external channel.

The product direction is informed by [SearXNG](https://github.com/searxng/searxng) and [Vane](https://github.com/ItzCrazyKns/Vane): privacy-preserving metasearch, source citations, bounded research, local history, and interchangeable local/cloud model connections.

SearXNG scopes map to its configured categories. The GitHub scope calls GitHub repository search directly so it remains useful even when the SearXNG instance has no GitHub-specific engine. See the [SearXNG search API](https://docs.searxng.org/dev/search_api.html) and [categories-as-tabs configuration](https://docs.searxng.org/admin/settings/settings_categories_as_tabs.html) for instance-level category support.

# bascule

*Bascule* is French for "switch over": when a provider fails, your request switches to the next one.

One local OpenAI-compatible endpoint in front of all your AI providers. When one fails or hits its rate limit, the request moves to the next one, down to a local Ollama model if you want. Single file, zero dependencies, under 50 MB of RAM at rest.

*Version française plus bas.*

## Install

Needs Node.js 20 or newer.

```bash
npm install -g bascule   # or clone the repo and run: node server.mjs
bascule init             # creates ~/.bascule/config.json and ~/.bascule/.env
# put your API keys in ~/.bascule/.env (empty = provider disabled)
bascule doctor           # checks every key and model; --deep sends one tiny request per model
bascule                  # http://127.0.0.1:8484/v1
```

Free models come and go every few weeks. `bascule discover` checks each provider's catalogue: models in your config that are no longer offered, new chat models you could use, and, where the catalogue has prices (OpenRouter), the ones that cost nothing. `bascule discover --apply` removes the retired models and adds up to 3 free ones per provider to the `auto` line, before the local fallback. Before adding a model it sends it one tiny request, so only models that really answer get in. The previous config is kept as `config.json.bak`. Stealth models (free because they keep your prompts for training) are never picked.

While it runs, `bascule status` shows live counters: requests, fallbacks, tokens, and the state of every target (ready, cooling, learned rate limit).

The same view lives in your browser: `bascule dashboard` opens http://127.0.0.1:8484/, which refreshes every 2 seconds and shows each line as a chain of targets, green when ready, orange while pausing, red when failing. The page is built into `server.mjs` (no extra files, nothing loaded from the internet) and reads the stats with your `BASCULE_KEY`.

Point any OpenAI client at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8484/v1", api_key="<BASCULE_KEY>")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hello"}])
```

`model` is a line name (`auto`, `fast`, `smart`, `local`), `provider/model` (`groq/openai/gpt-oss-120b`), or a bare model name. Leaving it out uses `defaultModel`.

## Features

- `POST /v1/chat/completions` (streaming and non-streaming), `POST /v1/embeddings`, `GET /v1/models`, `GET /stats`, `GET /health`.
- Fallback on 429, 5xx, 413, timeouts, network errors, invalid upstream JSON, and "prompt too long" errors (a model with a bigger context may take it). A plain 400 is returned as is, since every provider would reject it.
- Streaming fallback works as long as no byte has reached the client, including when a provider answers 200 and then puts the error in the stream. A failure after that ends the stream with an `error` event instead of cutting it silently.
- Separate timeouts: time to first byte, total time for plain calls, and maximum silence inside a stream.
- Several keys per provider, rotated on 429. Cooldowns honour `retry-after` and the delay some providers put in the error body (Gemini's `retryDelay`), back off exponentially, and park an invalid key for 30 minutes (including Gemini's 400 "invalid API key").
- Rate limits: when every target is only rate limited and one frees up within `maxWaitMs` (default 20 s), the request waits instead of failing. Otherwise it returns 429 with `retry-after`, which OpenAI SDKs honour.
- Size limits: a "request too large" answer (Groq's per-minute token cap, context limits) is learned per target. Larger requests skip that target from then on, smaller ones keep using it, and the target is not put on cooldown.
- Per-minute budgets: set `rpm` on a provider, or let bascule learn it from a 429 that states the quota (Gemini does). A target at its budget is skipped without calling it, so no quota is burnt on requests that could only fail.
- Identical concurrent `temperature: 0` requests share a single upstream call.
- Speed: upstream connections are kept alive and warmed up at start, which saves the 100-200 ms TLS handshake Node's `fetch` pays after 4 s of idle (measured: 170-190 ms less per request on Groq and Gemini). Lines can hedge: with `hedgeMs`, if the first target has not answered in time, the next one starts in parallel and the first answer wins (on by default for `auto`, 3 s, and `fast`, 1 s). bascule itself adds about 0.3 ms per request.
- Anthropic Messages API (`POST /v1/messages`, `/v1/messages/count_tokens`): Claude Code and the Anthropic SDKs work with any provider. Set `ANTHROPIC_BASE_URL=http://127.0.0.1:8484`. `aliases` map names such as `claude-*` onto lines.
- Empty answers, in-stream errors after a content-free first chunk, and tool calls rejected by the provider (Groq's `tool_use_failed`) all fall back to the next target.
- Per-provider `minMaxTokens` stops reasoning models from spending a small `max_tokens` on thinking and returning nothing; `params` adds provider-specific fields without overriding the client's.
- Capability learning: when a model rejects images or tools, the request moves to the next model, and bascule remembers the gap so later image or tool requests skip that model while text requests still use it. What it learns (capability gaps, per-minute quotas) is kept in `~/.bascule/state.json` across restarts.
- Text-only content arrays are sent as plain strings, for APIs such as Groq that accept nothing else.
- Line strategies: `priority` (default), `fastest` (measured latency), `round-robin`.
- OpenAI ⇄ Anthropic translation: system prompt, images, tools, tool results, streaming.
- Response cache for `temperature: 0` requests (LRU, 10 min by default).
- Client disconnect cancels the upstream request, so you are not billed for answers nobody reads.

## Configuration

Lookup order, first found wins:

| | config | keys |
|---|---|---|
| 1 | `$BASCULE_CONFIG` | environment variables |
| 2 | `./bascule.json` | `./.env`, read only when `./bascule.json` exists |
| 3 | `~/.bascule/config.json` | `~/.bascule/.env` |
| 4 | bundled `config.json` | bundled `.env` |

`config.json` lists `providers` (`type`: `openai` or `anthropic`, `baseUrl`, `keys`, `models`, optional `headers`, `rpm`, and `streamUsage: false` for APIs that reject `stream_options`) and `lines`: each line is a model name your apps can ask for (`auto`, `fast`...) and the ordered list of `provider/model` targets behind it, like the stations of a metro line. Top-level tuning: `timeoutMs`, `firstByteTimeoutMs`, `idleTimeoutMs`, `maxWaitMs`, `cache`, `corsOrigins`, `log`. `${VAR}` is replaced by the environment variable. Any OpenAI-compatible service works: add it with its base URL.

Edits to the config or the `.env` file are applied live, without restart (also on `SIGHUP`). An edit that does not parse is rejected and the previous config keeps running. Only the address and port need a restart.

Environment variables: `BASCULE_KEY`, `BASCULE_PORT`, `BASCULE_HOST`, `BASCULE_CONFIG`, `BASCULE_HOME`, `BASCULE_LOG=0` (silences the one-line-per-request log).

Model IDs change often. The bundled list was checked on 2026-09-23. `bascule doctor` flags any model the provider no longer lists, and `--deep` shows the ones that list but do not answer.

### Costs and daily budget

Give prices to paid models and Bascule counts what you spend. Prices are in US dollars per million tokens, `[input, output]`, for one model or a whole provider:

```json
"prices": { "openai/gpt-6-sol": [1.25, 10], "anthropic/*": [3, 15] },
"budget": { "dailyUsd": 2 }
```

Models without a price count as free. Once today's spend reaches `dailyUsd`, paid models are skipped until midnight (local time) and requests go to the free ones; a request that has only paid models left gets a 402 error. Today's spend survives restarts and shows in `bascule status` and on the dashboard. Copy prices from your provider's pricing page: Bascule does not guess them. Counts rely on the token usage each provider reports.

## Security

- Listens on `127.0.0.1` only by default.
- Binding to another address (`BASCULE_HOST=0.0.0.0`) is refused unless `BASCULE_KEY` holds 16+ characters.
- Browser requests are refused unless their origin is listed in `corsOrigins`, and `POST` requires `content-type: application/json`. Together these stop a web page you visit from spending your quotas through your local router.
- Your keys stay in `.env` on your machine and are only sent to the provider they belong to.

## Responsible use

bascule routes between accounts and keys you are entitled to use. Respect each provider's terms: do not create multiple free accounts to multiply a free tier, and do not plug in consumer subscriptions (ChatGPT Plus, Claude Pro…) as API keys. Providers ban accounts for both.

## Tests

```bash
node test.mjs   # 105 end-to-end tests against mock providers, no network, no keys
```

They cover fallback for every error class, key rotation, timeouts, streaming failures, the Anthropic translation, the security guards, 300 concurrent requests, memory growth over 3,000 requests, and the command line.

---

## En français

Une seule adresse locale, compatible OpenAI, devant tous tes fournisseurs d'IA. Si l'un tombe ou atteint sa limite, la requête passe au suivant, jusqu'à un modèle Ollama local si tu veux. Un seul fichier, aucune dépendance.

1. Installer Node.js 20+, puis `npm install -g bascule`.
2. `bascule init`, puis mettre tes clés API dans `~/.bascule/.env`.
3. `bascule doctor` pour vérifier que tes clés marchent.
   Pour Claude Code : `ANTHROPIC_BASE_URL=http://127.0.0.1:8484 claude`.
4. `bascule`, puis régler tes outils sur `http://127.0.0.1:8484/v1` avec le modèle `auto`. `bascule status` montre ce qui se passe, et `bascule dashboard` ouvre la même vue dans le navigateur, en direct. `bascule discover` repère les modèles retirés et les nouveaux modèles gratuits ; `bascule discover --apply` met la config à jour (après avoir vérifié que chaque modèle ajouté répond vraiment). Pour suivre vos dépenses, indiquez les prix des modèles payants (`prices`, en dollars par million de tokens) et un plafond (`budget.dailyUsd`) : une fois le plafond du jour atteint, seuls les modèles gratuits sont utilisés jusqu'à minuit.

Utilise seulement des comptes et des clés auxquels tu as droit : pas de comptes gratuits multiples, pas d'abonnement grand public utilisé comme clé API.

## Contributing

`node secrets-check.mjs` (or `npm run check`) refuses to let an API key leave your machine: it scans every tracked file and the npm package for the values in your `.env` and for anything shaped like a provider key. It runs before `npm publish` and in CI. To run it before each commit and push too:

```bash
printf '#!/bin/sh\nexec node secrets-check.mjs --staged\n' > .git/hooks/pre-commit
printf '#!/bin/sh\nexec node secrets-check.mjs\n' > .git/hooks/pre-push
chmod +x .git/hooks/pre-commit .git/hooks/pre-push
```

## Similar projects

Bascule is a small, independent project, written from scratch. If you need more, look at [LiteLLM](https://github.com/BerriAI/litellm) (Python proxy with teams, budgets and 100+ providers), [OmniRoute](https://github.com/diegosouzapw/OmniRoute) (full gateway with a web app, which can also use subscription accounts) or [OpenRouter](https://openrouter.ai) (hosted service, one key for many models). Bascule stays a single file with no dependencies, uses only API keys, free tiers and local models, and runs on your machine.

## License

MIT

# bascule

*Bascule* is French for "switch over": when a provider fails, your request switches to the next one.

One local OpenAI-compatible endpoint in front of all your AI providers. When one fails or hits its rate limit, the request moves to the next one, down to a local Ollama model if you want. Single file, zero dependencies, about 40 MB of RAM at rest.

*Version française plus bas.*

## Install

Needs Node.js 20 or newer.

```bash
npm install -g bascule   # or clone the repo and run: node server.mjs
bascule init             # creates ~/.bascule/config.json and ~/.bascule/.env
# put your API keys in ~/.bascule/.env (empty = provider disabled)
bascule                  # http://127.0.0.1:20129/v1
```

Point any OpenAI client at it:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:20129/v1", api_key="<BASCULE_KEY>")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hello"}])
```

`model` is a combo (`auto`, `fast`, `smart`, `local`), `provider/model` (`groq/openai/gpt-oss-120b`), or a bare model name. Leaving it out uses `defaultModel`.

## Features

- `POST /v1/chat/completions` (streaming and non-streaming), `POST /v1/embeddings`, `GET /v1/models`, `GET /stats`, `GET /health`.
- Fallback on 429, 5xx, 413, timeouts, network errors, invalid upstream JSON, and "prompt too long" errors (a model with a bigger context may take it). A plain 400 is returned as is, since every provider would reject it.
- Streaming fallback works as long as no byte has reached the client, including when a provider answers 200 and then puts the error in the stream. A failure after that ends the stream with an `error` event instead of cutting it silently.
- Separate timeouts: time to first byte, total time for plain calls, and maximum silence inside a stream.
- Several keys per provider, rotated on 429. Cooldowns honour `retry-after`, back off exponentially, and park an invalid key for 30 minutes.
- Combo strategies: `priority` (default), `fastest` (measured latency), `round-robin`.
- OpenAI ⇄ Anthropic translation: system prompt, images, tools, tool results, streaming.
- Response cache for `temperature: 0` requests (LRU, 10 min by default), whitespace compaction of prompts.
- Client disconnect cancels the upstream request, so you are not billed for answers nobody reads.

## Configuration

Lookup order, first found wins:

| | config | keys |
|---|---|---|
| 1 | `$BASCULE_CONFIG` | environment variables |
| 2 | `./bascule.json` | `./.env`, read only when `./bascule.json` exists |
| 3 | `~/.bascule/config.json` | `~/.bascule/.env` |
| 4 | bundled `config.json` | bundled `.env` |

`config.json` lists `providers` (`type`: `openai` or `anthropic`, `baseUrl`, `keys`, `models`, optional `headers` and `streamUsage: false` for APIs that reject `stream_options`) and `combos`. `${VAR}` is replaced by the environment variable. Any OpenAI-compatible service works: add it with its base URL.

Environment variables: `BASCULE_KEY`, `BASCULE_PORT`, `BASCULE_HOST`, `BASCULE_CONFIG`, `BASCULE_HOME`, `BASCULE_LOG=0` (silences the one-line-per-request log).

Model IDs change often. The bundled list was checked on 2026-09-23; `GET /stats` shows which targets fail, so a retired model is easy to spot and remove.

## Security

- Listens on `127.0.0.1` only by default.
- Binding to another address (`BASCULE_HOST=0.0.0.0`) is refused unless `BASCULE_KEY` holds 16+ characters.
- Browser requests are refused unless their origin is listed in `corsOrigins`, and `POST` requires `content-type: application/json`. Together these stop a web page you visit from spending your quotas through your local router.
- Your keys stay in `.env` on your machine and are only sent to the provider they belong to.

## Responsible use

bascule routes between accounts and keys you are entitled to use. Respect each provider's terms: do not create multiple free accounts to multiply a free tier, and do not plug in consumer subscriptions (ChatGPT Plus, Claude Pro…) as API keys. Providers ban accounts for both.

## Tests

```bash
node test.mjs   # 65 end-to-end tests against mock providers, no network, no keys
```

They cover fallback for every error class, key rotation, timeouts, streaming failures, the Anthropic translation, the security guards, 300 concurrent requests, memory growth over 3,000 requests, and the command line.

---

## En français

Une seule adresse locale, compatible OpenAI, devant tous tes fournisseurs d'IA. Si l'un tombe ou atteint sa limite, la requête passe au suivant, jusqu'à un modèle Ollama local si tu veux. Un seul fichier, aucune dépendance.

1. Installer Node.js 20+, puis `npm install -g bascule`.
2. `bascule init`, puis mettre tes clés API dans `~/.bascule/.env`.
3. `bascule`, puis régler tes outils sur `http://127.0.0.1:20129/v1` avec le modèle `auto`.

Utilise seulement des comptes et des clés auxquels tu as droit : pas de comptes gratuits multiples, pas d'abonnement grand public utilisé comme clé API.

## License

MIT

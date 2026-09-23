#!/usr/bin/env node
// Bascule — lean OpenAI-compatible AI router. Zero dependencies, Node >= 20.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = join(homedir(), '.bascule');

// `bascule init`: per-user config in ~/.bascule, so a global npm install works.
if (process.argv[2] === 'init') {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const cfgOut = join(HOME_DIR, 'config.json'), envOut = join(HOME_DIR, '.env');
  if (!existsSync(cfgOut)) copyFileSync(join(ROOT, 'config.json'), cfgOut);
  if (!existsSync(envOut)) {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    writeFileSync(envOut, example.replace(/^BASCULE_KEY=.*$/m, `BASCULE_KEY=${randomBytes(24).toString('hex')}`), { mode: 0o600 });
  }
  console.log(`config: ${cfgOut}\nkeys:   ${envOut}  (add your provider API keys, then run: bascule)`);
  process.exit(0);
}

// First existing file wins: explicit env var, current directory, ~/.bascule, bundled default.
const firstExisting = (...paths) => paths.find((p) => p && existsSync(p));

// ---------- config ----------
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile(firstExisting(join(process.cwd(), '.env'), join(HOME_DIR, '.env'), join(ROOT, '.env')) || '');

const expand = (v) =>
  typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '')
  : Array.isArray(v) ? v.map(expand)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  : v;

const CONFIG_PATH = firstExisting(process.env.BASCULE_CONFIG, join(process.cwd(), 'bascule.json'),
  join(HOME_DIR, 'config.json'), join(ROOT, 'config.json'));
const cfg = expand(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
const PORT = Number(process.env.PORT || cfg.port || 20129);
const HOST = process.env.HOST || cfg.host || '127.0.0.1';
const API_KEY = process.env.BASCULE_KEY || cfg.apiKey || '';
const CORS = [].concat(cfg.corsOrigins ?? []); // browser origins allowed to call; none by default

// Exposing the router beyond this machine without a strong key would let anyone spend the owner's quotas.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
if (!LOOPBACK && (API_KEY.length < 16 || API_KEY === 'change-me')) {
  console.error(`refusing to listen on ${HOST}: set BASCULE_KEY to a random value of 16+ characters (bascule init makes one)`);
  process.exit(1);
}
const TIMEOUT = cfg.timeoutMs ?? 120_000;
const FIRST_BYTE_TIMEOUT = cfg.firstByteTimeoutMs ?? 30_000;
const CACHE_MAX = cfg.cache?.maxEntries ?? 500;
const CACHE_TTL = cfg.cache?.ttlMs ?? 10 * 60_000;
const COMPACT = cfg.compactWhitespace ?? true;

// ---------- providers & targets ----------
// Provider: { type: 'openai'|'anthropic', baseUrl, keys: [..], headers, models: [..] }
const providers = {};
for (const [name, p] of Object.entries(cfg.providers || {})) {
  const keys = [].concat(p.keys ?? p.key ?? []).filter(Boolean);
  if (p.requiresKey !== false && keys.length === 0) continue; // skip unconfigured providers
  providers[name] = { name, type: p.type || 'openai', baseUrl: p.baseUrl.replace(/\/$/, ''),
    keys: keys.length ? keys : [''], headers: p.headers || {}, models: p.models || [], rr: 0 };
}

// Health per "provider/model/keyIndex": cooldown + EWMA latency + failure streak.
const health = new Map();
const h = (id) => health.get(id) ?? (health.set(id, { until: 0, fails: 0, lat: 0, ok: 0, err: 0 }), health.get(id));

function cooldown(id, status, retryAfter) {
  const s = h(id);
  s.fails++; s.err++;
  let ms = retryAfter ? retryAfter * 1000 : Math.min(1000 * 2 ** Math.min(s.fails, 8), 5 * 60_000);
  if (status === 401 || status === 403) ms = 30 * 60_000; // bad key: park it
  s.until = Date.now() + ms;
}
function success(id, ms) {
  const s = h(id);
  s.fails = 0; s.until = 0; s.ok++;
  s.lat = s.lat ? s.lat * 0.8 + ms * 0.2 : ms;
}

// Resolve requested model into ordered list of { provider, model }.
function resolve(model) {
  const combo = cfg.combos?.[model];
  let list;
  if (combo) {
    const targets = Array.isArray(combo) ? combo : combo.targets;
    const strategy = Array.isArray(combo) ? 'priority' : combo.strategy || 'priority';
    list = targets.map(parseTarget).filter(Boolean);
    if (strategy === 'fastest') {
      list.sort((a, b) => (h(a.id + '#0').lat || 1e9) - (h(b.id + '#0').lat || 1e9));
    } else if (strategy === 'round-robin') {
      const n = (combo._rr = ((combo._rr ?? -1) + 1) % list.length);
      list = [...list.slice(n), ...list.slice(0, n)];
    }
  } else {
    const t = parseTarget(model);
    list = t ? [t] : [];
  }
  return list;
}
function parseTarget(s) {
  const i = s.indexOf('/');
  if (i > 0 && providers[s.slice(0, i)]) {
    return { provider: providers[s.slice(0, i)], model: s.slice(i + 1), id: s };
  }
  // Bare model name: first provider that lists it.
  const p = Object.values(providers).find((p) => p.models.includes(s));
  return p ? { provider: p, model: s, id: `${p.name}/${s}` } : null;
}

// Keys for a target, healthy first, rotated round-robin.
function keysFor(t) {
  const p = t.provider, n = p.keys.length, start = p.rr++ % n, now = Date.now();
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (start + i) % n;
    out.push({ key: p.keys[k], hid: `${t.id}#${k}`, cool: h(`${t.id}#${k}`).until > now });
  }
  return out.sort((a, b) => a.cool - b.cool);
}

// ---------- request shaping ----------
function compact(body) {
  if (!COMPACT || !Array.isArray(body.messages)) return body;
  const squeeze = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  for (const m of body.messages) {
    if (typeof m.content === 'string') m.content = squeeze(m.content);
    else if (Array.isArray(m.content)) for (const c of m.content) if (c.type === 'text' && c.text) c.text = squeeze(c.text);
  }
  return body;
}

// OpenAI -> Anthropic request
function toAnthropic(body, model) {
  const system = [], messages = [];
  const text = (c) => (typeof c === 'string' ? c : (c || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n'));
  const parts = (c) => {
    if (typeof c === 'string') return [{ type: 'text', text: c }];
    return (c || []).map((x) => {
      if (x.type !== 'image_url') return { type: 'text', text: x.text ?? '' };
      const url = x.image_url?.url || '';
      const m = url.match(/^data:([^;]+);base64,(.*)$/);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
               : { type: 'image', source: { type: 'url', url } };
    });
  };
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks); // Anthropic needs alternation
    else messages.push({ role, content: blocks });
  };
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') { system.push(text(m.content)); continue; }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = m.content ? parts(m.content).filter((b) => b.type !== 'text' || b.text) : [];
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) push('assistant', blocks);
      continue;
    }
    push('user', parts(m.content));
  }
  const out = { model, messages, max_tokens: body.max_completion_tokens || body.max_tokens || 4096 };
  if (system.length) out.system = system.join('\n\n');
  for (const k of ['temperature', 'top_p', 'stream']) if (body[k] !== undefined) out[k] = body[k];
  if (body.stop) out.stop_sequences = [].concat(body.stop);
  if (body.tools?.length) {
    out.tools = body.tools.map((t) => ({ name: t.function.name, description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    const tc = body.tool_choice;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') out.tool_choice = { type: 'none' };
    else if (tc?.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  }
  return out;
}

const STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls' };

// Anthropic -> OpenAI response
function fromAnthropic(r, model) {
  let content = '';
  const tool_calls = [];
  for (const b of r.content || []) {
    if (b.type === 'text') content += b.text;
    else if (b.type === 'tool_use') tool_calls.push({ id: b.id, type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const msg = { role: 'assistant', content: content || null };
  if (tool_calls.length) msg.tool_calls = tool_calls;
  const u = r.usage || {};
  return { id: r.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: msg, finish_reason: STOP[r.stop_reason] || 'stop' }],
    usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0,
      total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0) } };
}

// Anthropic SSE -> OpenAI SSE, as async generator of strings.
async function* anthropicStream(reader, model) {
  const id = 'chatcmpl-' + Date.now().toString(36), created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null, extra) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const toolIdx = new Map(); // anthropic block index -> openai tool index
  let inTok = 0;
  yield chunk({ role: 'assistant', content: '' });
  for await (const ev of sseEvents(reader)) {
    let d;
    try { d = JSON.parse(ev); } catch { continue; }
    if (d.type === 'message_start') inTok = d.message?.usage?.input_tokens || 0;
    else if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
      const i = toolIdx.size;
      toolIdx.set(d.index, i);
      yield chunk({ tool_calls: [{ index: i, id: d.content_block.id, type: 'function',
        function: { name: d.content_block.name, arguments: '' } }] });
    } else if (d.type === 'content_block_delta') {
      if (d.delta.type === 'text_delta') yield chunk({ content: d.delta.text });
      else if (d.delta.type === 'input_json_delta')
        yield chunk({ tool_calls: [{ index: toolIdx.get(d.index), function: { arguments: d.delta.partial_json } }] });
    } else if (d.type === 'message_delta') {
      const out = d.usage?.output_tokens || 0;
      yield chunk({}, STOP[d.delta?.stop_reason] || 'stop',
        { usage: { prompt_tokens: inTok, completion_tokens: out, total_tokens: inTok + out } });
    } else if (d.type === 'error') {
      throw new Error(d.error?.message || 'upstream stream error');
    }
  }
  yield 'data: [DONE]\n\n';
}

// Yields the data payload of each SSE event.
async function* sseEvents(reader) {
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}

// ---------- upstream call ----------
function buildRequest(t, key, body) {
  const p = t.provider;
  if (p.type === 'anthropic') {
    return { url: `${p.baseUrl}/v1/messages`, payload: toAnthropic(body, t.model),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...p.headers } };
  }
  const payload = { ...body, model: t.model };
  if (payload.stream) payload.stream_options = { include_usage: true, ...payload.stream_options };
  return { url: `${p.baseUrl}/chat/completions`, payload,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...p.headers } };
}

class Upstream extends Error {
  constructor(status, msg, retryAfter) { super(msg); this.status = status; this.retryAfter = retryAfter; }
}

async function callOnce(t, k, body, clientSignal) {
  const { url, payload, headers } = buildRequest(t, k.key, body);
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  clientSignal.addEventListener('abort', onAbort, { once: true });
  const total = setTimeout(() => ctl.abort(), TIMEOUT);
  const firstByte = setTimeout(() => ctl.abort(), FIRST_BYTE_TIMEOUT);
  const cleanup = () => { clearTimeout(total); clientSignal.removeEventListener('abort', onAbort); };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload), signal: ctl.signal });
  } catch (e) {
    clearTimeout(firstByte); cleanup();
    throw new Upstream(0, clientSignal.aborted ? 'client aborted' : `network: ${e.cause?.code || e.message}`);
  }
  clearTimeout(firstByte);
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    cleanup();
    const ra = Number(res.headers.get('retry-after')) || 0;
    throw new Upstream(res.status, txt.slice(0, 500) || res.statusText, ra);
  }
  return { res, t0, cleanup };
}

// Errors that mean "try next target". 400/422 = bad request: same on every provider, stop.
const retryable = (e) => e.status === 0 || e.status === 401 || e.status === 403 || e.status === 404
  || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;

// ---------- cache ----------
const cache = new Map();
const cacheKey = (b) => createHash('sha1').update(JSON.stringify(b)).digest('hex');
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, e); // LRU bump
  return e.v;
}
function cacheSet(k, v) {
  cache.set(k, { v, exp: Date.now() + CACHE_TTL });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------- stats ----------
const stats = { requests: 0, cacheHits: 0, fallbacks: 0, failures: 0, tokens: { prompt: 0, completion: 0 } };
const addUsage = (u) => { if (u) { stats.tokens.prompt += u.prompt_tokens || 0; stats.tokens.completion += u.completion_tokens || 0; } };

// ---------- handlers ----------
async function chat(req, res, body) {
  stats.requests++;
  const requested = body.model;
  const targets = resolve(requested || cfg.defaultModel || '');
  if (!targets.length) return send(res, 404, err(`unknown model "${requested}"`, 'model_not_found'));
  compact(body);

  const cacheable = !body.stream && CACHE_MAX > 0 && (body.temperature === 0 || cfg.cache?.always);
  const ck = cacheable ? cacheKey({ ...body, model: requested }) : null;
  if (ck) {
    const hit = cacheGet(ck);
    if (hit) { stats.cacheHits++; return send(res, 200, hit, { 'x-bascule-cache': 'hit' }); }
  }

  const clientAbort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) clientAbort.abort(); });

  // Healthy (target, key) pairs first in combo order; cooled ones last as a final resort.
  const pairs = targets.flatMap((t) => keysFor(t).map((k) => ({ t, k })));
  pairs.sort((a, b) => a.k.cool - b.k.cool);
  const deadTargets = new Set();
  const errors = [];
  let attempt = 0;
  for (const { t, k } of pairs) {
      if (deadTargets.has(t.id)) continue;
      if (clientAbort.signal.aborted) return;
      if (attempt++) stats.fallbacks++;
      let up;
      try {
        up = await callOnce(t, k, body, clientAbort.signal);
      } catch (e) {
        if (clientAbort.signal.aborted) return;
        errors.push(`${t.id}: ${e.status || 'ERR'} ${e.message.slice(0, 160)}`);
        cooldown(k.hid, e.status, e.retryAfter);
        if (!retryable(e)) return send(res, e.status, err(e.message, 'upstream_error'));
        // 401/403/429 are key-level: try next key. Anything else is provider-level: skip its other keys.
        if (!(e.status === 401 || e.status === 403 || e.status === 429)) deadTargets.add(t.id);
        continue;
      }
      const head = { 'x-bascule-target': t.id };
      try {
        if (body.stream) await pipeStream(up, t, res, head);
        else {
          const raw = await up.res.json();
          const out = t.provider.type === 'anthropic' ? fromAnthropic(raw, t.model) : raw;
          addUsage(out.usage);
          if (ck) cacheSet(ck, out);
          send(res, 200, out, head);
        }
        success(k.hid, Date.now() - up.t0);
      } catch (e) {
        cooldown(k.hid, 0);
        if (!res.headersSent) { errors.push(`${t.id}: ${e.message}`); up.cleanup(); continue; }
        res.end(); // mid-stream failure: cannot fallback after bytes left
      } finally { up.cleanup(); }
      return;
  }
  stats.failures++;
  send(res, 503, err(`all targets failed:\n${errors.join('\n')}`, 'all_targets_failed'));
}

async function pipeStream(up, t, res, head) {
  const reader = up.res.body.getReader();
  const gen = t.provider.type === 'anthropic' ? anthropicStream(reader, t.model) : passthrough(reader);
  // Pull first chunk before committing headers: allows fallback if upstream dies instantly.
  const first = await gen.next();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
    connection: 'keep-alive', 'x-accel-buffering': 'no', ...head });
  if (!first.done) res.write(first.value);
  for await (const s of gen) if (!res.write(s)) await new Promise((r) => res.once('drain', r));
  res.end();
}

async function* passthrough(reader) {
  const dec = new TextDecoder();
  let tail = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    yield s;
    // Track usage from final chunk without re-parsing everything.
    tail = (tail + s).slice(-4096);
  }
  const m = tail.match(/"usage":\s*(\{[^}]*\})/g);
  if (m) try { addUsage(JSON.parse(m[m.length - 1].replace(/^"usage":\s*/, ''))); } catch {}
}

function listModels() {
  const data = [];
  for (const name of Object.keys(cfg.combos || {})) data.push({ id: name, object: 'model', owned_by: 'bascule' });
  for (const p of Object.values(providers)) for (const m of p.models) data.push({ id: `${p.name}/${m}`, object: 'model', owned_by: p.name });
  return { object: 'list', data };
}

function status() {
  const now = Date.now();
  const targets = {};
  for (const [id, s] of health) targets[id] = { ok: s.ok, err: s.err, latencyMs: Math.round(s.lat),
    coolingForS: s.until > now ? Math.ceil((s.until - now) / 1000) : 0 };
  return { uptimeS: Math.round(process.uptime()), providers: Object.keys(providers), cacheSize: cache.size, ...stats, targets };
}

// ---------- http ----------
const err = (message, code) => ({ error: { message, type: code, code } });
function send(res, code, obj, headers = {}) {
  if (res.headersSent) return res.end();
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
  res.end(s);
}
function authed(req) {
  if (!API_KEY) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(String(got)), b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}
function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { ko(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ko);
  });
}

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0].replace(/\/+$/, '');
  // Any web page can fire requests at localhost. Only listed origins get through, otherwise
  // a malicious site could spend the owner's quotas even without reading the answer.
  const origin = req.headers.origin;
  if (origin) {
    if (!CORS.includes(origin) && !CORS.includes('*')) return send(res, 403, err(`origin ${origin} not allowed (config: corsOrigins)`, 'forbidden_origin'));
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-headers': 'authorization,content-type,x-api-key', 'access-control-allow-methods': 'GET,POST' });
    return res.end();
  }
  if (path === '/health') return send(res, 200, { ok: true });
  if (!authed(req)) return send(res, 401, err('invalid api key', 'unauthorized'));
  // A JSON content type cannot be sent by a plain HTML form, which closes the no-preflight CSRF path.
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || ''))
    return send(res, 415, err('content-type must be application/json', 'unsupported_media_type'));
  try {
    if (req.method === 'GET' && path === '/v1/models') return send(res, 200, listModels());
    if (req.method === 'GET' && path === '/stats') return send(res, 200, status());
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, err(`bad json: ${e.message}`, 'invalid_request')); }
      return await chat(req, res, body);
    }
    send(res, 404, err('not found', 'not_found'));
  } catch (e) {
    console.error(e);
    send(res, 500, err(e.message, 'internal'));
  }
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(PORT, HOST, () => {
  console.log(`bascule on http://${HOST}:${PORT}/v1  providers: ${Object.keys(providers).join(', ') || '(none — set keys in .env)'}`);
  console.log(`config: ${CONFIG_PATH}${API_KEY ? '' : '  (no BASCULE_KEY: any local program can use it)'}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));

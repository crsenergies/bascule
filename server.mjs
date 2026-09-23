#!/usr/bin/env node
// Bascule — lean OpenAI-compatible AI router. Zero dependencies, Node >= 20.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, watchFile, renameSync } from 'node:fs';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.BASCULE_HOME || join(homedir(), '.bascule');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// ---------- cli ----------
const arg = process.argv[2];
if (arg === '--version' || arg === '-v') { console.log(VERSION); process.exit(0); }
if (arg === '--help' || arg === '-h') {
  console.log(`bascule ${VERSION} — OpenAI-compatible AI router with automatic fallback

  bascule init      create ~/.bascule/config.json and ~/.bascule/.env (random access key)
  bascule           start the router (default http://127.0.0.1:20129/v1)
  bascule doctor    check every configured key and model (add --deep to send a tiny real request)
  bascule status    show live stats of the running router

Config and keys are reloaded automatically when their files change (or on SIGHUP).

Environment: BASCULE_KEY, BASCULE_PORT, BASCULE_HOST, BASCULE_CONFIG, BASCULE_HOME, BASCULE_LOG=0`);
  process.exit(0);
}
// `bascule init`: per-user config in ~/.bascule, so a global npm install works.
if (arg === 'init') {
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
if (arg && !['doctor', 'status'].includes(arg)) { console.error(`unknown argument "${arg}" (try --help)`); process.exit(2); }

// ---------- config ----------
// Variables already set in the real environment win over the file. Those that came from the
// file are remembered, so a reload can update them.
const fromFile = new Set();
function loadEnvFile(path) {
  if (!path || !existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || (process.env[m[1]] !== undefined && !fromFile.has(m[1]))) continue;
    fromFile.add(m[1]);
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // inline comment on an unquoted value
    process.env[m[1]] = v;
  }
}

// First existing path wins. A project-local setup needs ./bascule.json, so running bascule
// inside an unrelated project never picks up that project's .env (and its PORT, keys...).
const firstExisting = (...paths) => paths.find((p) => p && existsSync(p));
const LOCAL_CFG = join(process.cwd(), 'bascule.json');
const localSetup = existsSync(LOCAL_CFG);
const ENV_PATH = localSetup ? join(process.cwd(), '.env') : firstExisting(join(HOME_DIR, '.env'), join(ROOT, '.env'));
loadEnvFile(ENV_PATH);

const expand = (v) =>
  typeof v === 'string' ? v.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '')
  : Array.isArray(v) ? v.map(expand)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
  : v;

const CONFIG_PATH = firstExisting(process.env.BASCULE_CONFIG, localSetup && LOCAL_CFG,
  join(HOME_DIR, 'config.json'), join(ROOT, 'config.json'));
const readConfig = () => {
  const c = expand(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')));
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config must be a JSON object');
  return c;
};
let cfg;
try { cfg = readConfig(); }
catch (e) { console.error(`cannot read config ${CONFIG_PATH}: ${e.message}`); process.exit(1); }

// Address is fixed for the process lifetime; everything below can change on reload.
const PORT = Number(process.env.BASCULE_PORT || cfg.port || 20129);
const HOST = process.env.BASCULE_HOST || cfg.host || '127.0.0.1';
let API_KEY, CORS, TIMEOUT, FIRST_BYTE_TIMEOUT, IDLE_TIMEOUT, CACHE_MAX, CACHE_TTL, COMPACT, LOG, MAX_WAIT;
function applySettings() {
  API_KEY = process.env.BASCULE_KEY || cfg.apiKey || '';
  CORS = [].concat(cfg.corsOrigins ?? []);       // browser origins allowed to call; none by default
  TIMEOUT = cfg.timeoutMs ?? 120_000;            // whole non-streaming call
  FIRST_BYTE_TIMEOUT = cfg.firstByteTimeoutMs ?? 30_000;
  IDLE_TIMEOUT = cfg.idleTimeoutMs ?? 60_000;    // max silence inside a stream
  CACHE_MAX = cfg.cache?.maxEntries ?? 500;
  CACHE_TTL = cfg.cache?.ttlMs ?? 10 * 60_000;
  COMPACT = cfg.compactWhitespace ?? true;
  LOG = process.env.BASCULE_LOG !== '0' && cfg.log !== false;
  MAX_WAIT = cfg.maxWaitMs ?? 20_000;           // how long a request may wait for a rate limit to clear
}
applySettings();

// Exposing the router beyond this machine without a strong key would let anyone spend the owner's quotas.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
if (!LOOPBACK && (API_KEY.length < 16 || API_KEY === 'change-me')) {
  console.error(`refusing to listen on ${HOST}: set BASCULE_KEY to a random value of 16+ characters (bascule init makes one)`);
  process.exit(1);
}

// ---------- providers & targets ----------
// Provider: { type: 'openai'|'anthropic', baseUrl, keys: [..], headers, models: [..], streamUsage }
function buildProviders(c) {
  const out = {};
  for (const [name, p] of Object.entries(c.providers || {})) {
  const keys = [].concat(p.keys ?? p.key ?? []).filter(Boolean);
    if (p.requiresKey !== false && keys.length === 0) continue; // skip unconfigured providers
    if (!p.baseUrl) { console.error(`provider "${name}" has no baseUrl, ignored`); continue; }
    out[name] = { name, type: p.type || 'openai', baseUrl: p.baseUrl.replace(/\/+$/, ''),
      keys: keys.length ? keys : [''], headers: p.headers || {}, models: p.models || [],
      streamUsage: p.streamUsage !== false, rpm: Number(p.rpm) || 0, rr: 0 };
  }
  return out;
}
let providers = buildProviders(cfg);

// Swap in a new config only if it parses and builds; a typo while editing keeps the old one running.
function reload(reason) {
  try {
    loadEnvFile(ENV_PATH);
    const next = readConfig();
    const nextProviders = buildProviders(next);
    const key = process.env.BASCULE_KEY || next.apiKey || '';
    if (!LOOPBACK && (key.length < 16 || key === 'change-me')) throw new Error('BASCULE_KEY too weak for a non-local address');
    cfg = next; providers = nextProviders;
    applySettings();
    console.log(`reloaded (${reason})  providers: ${Object.keys(providers).join(', ') || '(none)'}`);
  } catch (e) {
    console.error(`reload failed, keeping previous config: ${e.message}`);
  }
}

// Health per "provider/model#keyIndex": cooldown + EWMA latency + failure streak.
const health = new Map();
const h = (id) => health.get(id) ?? (health.set(id, { until: 0, fails: 0, lat: 0, ok: 0, err: 0 }), health.get(id));

function cooldown(id, status, retryAfter) {
  const s = h(id);
  s.fails++; s.err++;
  // Floor of 250 ms: a provider announcing "retry in 1ms" must not turn the wait loop into a busy loop.
  let ms = retryAfter ? Math.max(retryAfter * 1000, 250) : Math.min(1000 * 2 ** Math.min(s.fails, 8), 5 * 60_000);
  if (status === 401 || status === 403) ms = 30 * 60_000; // bad key: park it
  s.until = Date.now() + ms;
  // A delay stated by the provider (or a dead key) is certain; a guessed backoff is not.
  s.hard = Boolean(retryAfter) || status === 401 || status === 403;
}
function success(id, ms) {
  const s = h(id);
  s.fails = 0; s.until = 0; s.hard = false; s.ok++;
  s.lat = s.lat ? s.lat * 0.8 + ms * 0.2 : ms;
}
// Best measured latency across a target's keys. Unmeasured targets sort first: otherwise a
// target that has never been tried would never get measured, and "fastest" could not find it.
const latency = (t) => Math.min(...t.provider.keys.map((_, k) => h(`${t.id}#${k}`).lat || 0));

// Resolve requested model into ordered list of { provider, model, id }.
function resolve(model) {
  const combo = Object.hasOwn(cfg.combos || {}, model) ? cfg.combos[model] : null;
  if (!combo) { const t = parseTarget(model); return t ? [t] : []; }
  const targets = Array.isArray(combo) ? combo : combo.targets || [];
  const strategy = Array.isArray(combo) ? 'priority' : combo.strategy || 'priority';
  let list = targets.map(parseTarget).filter(Boolean);
  if (strategy === 'fastest') list.sort((a, b) => latency(a) - latency(b));
  else if (strategy === 'round-robin' && list.length) {
    const n = (combo._rr = ((combo._rr ?? -1) + 1) % list.length);
    list = [...list.slice(n), ...list.slice(0, n)];
  }
  return list;
}
function parseTarget(s) {
  if (typeof s !== 'string' || !s) return null;
  const i = s.indexOf('/');
  if (i > 0 && Object.hasOwn(providers, s.slice(0, i))) {
    return { provider: providers[s.slice(0, i)], model: s.slice(i + 1), id: s };
  }
  // Bare model name: first provider that lists it.
  const p = Object.values(providers).find((p) => p.models.includes(s));
  return p ? { provider: p, model: s, id: `${p.name}/${s}` } : null;
}

// Keys for a target, rotated round-robin; cooling state is read when the pair is tried.
// Health is tracked per endpoint: a model that cannot embed must not be benched for chat.
function keysFor(t, endpoint) {
  const p = t.provider, n = p.keys.length, start = p.rr++ % n;
  const scope = endpoint === '/chat/completions' ? '' : `${endpoint.slice(1)}:`;
  return Array.from({ length: n }, (_, i) => {
    const k = (start + i) % n;
    return { key: p.keys[k], hid: `${scope}${t.id}#${k}` };
  });
}

// ---------- request shaping ----------
function compact(body) {
  if (!COMPACT || !Array.isArray(body.messages)) return body;
  const squeeze = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  for (const m of body.messages) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') m.content = squeeze(m.content);
    else if (Array.isArray(m.content)) for (const c of m.content) if (c?.type === 'text' && typeof c.text === 'string') c.text = squeeze(c.text);
  }
  return body;
}

// OpenAI -> Anthropic request
function toAnthropic(body, model) {
  const system = [], messages = [];
  const text = (c) => (typeof c === 'string' ? c : (c || []).filter((x) => x?.type === 'text').map((x) => x.text).join('\n'));
  const parts = (c) => {
    if (typeof c === 'string') return [{ type: 'text', text: c }];
    return (c || []).map((x) => {
      if (x?.type === 'image_url') {
        const url = x.image_url?.url || '';
        const m = url.match(/^data:([^;]+);base64,(.*)$/s);
        return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
                 : { type: 'image', source: { type: 'url', url } };
      }
      return { type: 'text', text: x?.text ?? '' };
    });
  };
  // Anthropic rejects empty text blocks and empty messages.
  const clean = (blocks) => {
    const out = blocks.filter((b) => b.type !== 'text' || b.text.trim());
    return out.length ? out : [{ type: 'text', text: '.' }];
  };
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks); // Anthropic needs alternation
    else messages.push({ role, content: blocks });
  };
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') { system.push(text(m.content)); continue; }
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text(m.content) || '(empty)' }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = m.content ? parts(m.content).filter((b) => b.type !== 'text' || b.text.trim()) : [];
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length) push('assistant', blocks);
      continue;
    }
    push('user', clean(parts(m.content)));
  }
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '.' }] });
  const out = { model, messages, max_tokens: body.max_completion_tokens || body.max_tokens || 4096 };
  if (system.length) out.system = system.join('\n\n');
  // OpenAI temperature goes up to 2, Anthropic's stops at 1.
  if (typeof body.temperature === 'number') out.temperature = Math.min(Math.max(body.temperature, 0), 1);
  for (const k of ['top_p', 'stream']) if (body[k] !== undefined) out[k] = body[k];
  if (body.stop) out.stop_sequences = [].concat(body.stop);
  if (body.tools?.length) {
    out.tools = body.tools.filter((t) => t.function).map((t) => ({ name: t.function.name, description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    const tc = body.tool_choice;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') out.tool_choice = { type: 'none' };
    else if (tc?.function?.name) out.tool_choice = { type: 'tool', name: tc.function.name };
  }
  return out;
}

const STOP = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };

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
async function* anthropicStream(reader, model, onUsage) {
  const id = 'chatcmpl-' + randomBytes(8).toString('hex'), created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish = null, extra) =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  const toolIdx = new Map(); // anthropic block index -> openai tool index
  let inTok = 0, started = false;
  for await (const ev of sseEvents(reader)) {
    let d;
    try { d = JSON.parse(ev); } catch { continue; }
    if (d.type === 'error') throw new Upstream(502, d.error?.message || 'upstream stream error');
    // Nothing is sent before the upstream proves healthy, so an early error can still fall back.
    if (!started) { started = true; yield chunk({ role: 'assistant', content: '' }); }
    if (d.type === 'message_start') inTok = d.message?.usage?.input_tokens || 0;
    else if (d.type === 'content_block_start' && d.content_block?.type === 'tool_use') {
      const i = toolIdx.size;
      toolIdx.set(d.index, i);
      yield chunk({ tool_calls: [{ index: i, id: d.content_block.id, type: 'function',
        function: { name: d.content_block.name, arguments: '' } }] });
    } else if (d.type === 'content_block_delta') {
      if (d.delta.type === 'text_delta') yield chunk({ content: d.delta.text });
      else if (d.delta.type === 'input_json_delta' && toolIdx.has(d.index))
        yield chunk({ tool_calls: [{ index: toolIdx.get(d.index), function: { arguments: d.delta.partial_json } }] });
    } else if (d.type === 'message_delta') {
      const out = d.usage?.output_tokens || 0;
      const usage = { prompt_tokens: inTok, completion_tokens: out, total_tokens: inTok + out };
      onUsage(usage);
      yield chunk({}, STOP[d.delta?.stop_reason] || 'stop', { usage });
    }
  }
  if (!started) throw new Upstream(502, 'empty stream');
  yield 'data: [DONE]\n\n';
}

// Yields the data payload of each SSE event.
async function* sseEvents(reader) {
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // Normalise line endings on the joined buffer, not per chunk: a CRLF can straddle two chunks.
    // A trailing lone CR is kept until the next chunk shows whether an LF follows it.
    buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n|\r(?!$)/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}

// OpenAI-compatible SSE is forwarded untouched, except that the first data event is inspected:
// some providers answer 200 and then put the error in the stream, which must still fall back.
async function* passthrough(reader, onUsage) {
  const dec = new TextDecoder();
  let head = '', checked = false, tail = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    tail = (tail + s).slice(-16_384);
    if (!checked) {
      head += s;
      const m = head.replace(/\r\n/g, '\n').match(/^data:[ \t]*(.*)\n\n/m);
      if (!m) continue; // keep buffering until the first data event is complete
      checked = true;
      let first;
      try { first = JSON.parse(m[1]); } catch {}
      if (first?.error) throw new Upstream(Number(first.error.code) || 502, first.error.message || JSON.stringify(first.error));
      yield head;
      continue;
    }
    yield s;
  }
  if (!checked) {
    if (!head.trim()) throw new Upstream(502, 'empty stream');
    yield head;
  }
  // Usage sits in the last chunk(s); parse whole events so nested objects are handled.
  for (const ev of tail.replace(/\r\n/g, '\n').split('\n\n').reverse()) {
    const line = ev.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    try { const j = JSON.parse(line.slice(5)); if (j.usage) { onUsage(j.usage); break; } } catch {}
  }
}

// ---------- upstream call ----------
function buildRequest(t, key, body, endpoint) {
  const p = t.provider;
  if (p.type === 'anthropic') {
    return { url: `${p.baseUrl}/v1/messages`, payload: toAnthropic(body, t.model),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...p.headers } };
  }
  const payload = { ...body, model: t.model };
  // Some OpenAI-compatible APIs (Groq) only accept string content. A text-only parts array
  // means exactly the same thing as its joined text, so send that.
  if (Array.isArray(body.messages) && body.messages.some((m) => Array.isArray(m?.content)))
    payload.messages = body.messages.map((m) => (Array.isArray(m?.content) && m.content.every((c) => c?.type === 'text')
      ? { ...m, content: m.content.map((c) => c.text ?? '').join('\n') } : m));
  if (payload.stream && p.streamUsage) payload.stream_options = { include_usage: true, ...payload.stream_options };
  return { url: `${p.baseUrl}${endpoint}`, payload,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...p.headers } };
}

class Upstream extends Error {
  constructor(status, msg, retryAfter, rpm) { super(msg); this.status = status; this.retryAfter = retryAfter; this.rpm = rpm; }
}

// retry-after is either seconds or an HTTP date.
function retryAfterS(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, (d - Date.now()) / 1000) : 0;
}

// Gemini puts the delay in the body ("retryDelay": "11s"); OpenAI-style APIs in the message ("try again in 1.2s").
function retryFromBody(txt) {
  const m = txt.match(/"retryDelay"\s*:\s*"([\d.]+)s"/) || txt.match(/(?:retry|try again) in ([\d.]+)\s*(ms|s)\b/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return m[2] === 'ms' ? n / 1000 : n;
}

// Gemini's 429 names the per-minute quota it hit ("quotaId": "...PerMinute...", "quotaValue": "15").
function rpmFromBody(txt) {
  // quotaDimensions {...} sits between the two fields, so allow nested braces but stay within one violation.
  const m = txt.match(/"quotaId"\s*:\s*"[^"]*PerMinute[^"]*"[\s\S]{0,400}?"quotaValue"\s*:\s*"(\d+)"/);
  return m ? Number(m[1]) : 0;
}

async function callOnce(t, k, body, clientSignal, endpoint) {
  const { url, payload, headers } = buildRequest(t, k.key, body, endpoint);
  const ctl = new AbortController();
  let why = '';
  const abort = (reason) => { why ||= reason; ctl.abort(); };
  const onAbort = () => abort('client aborted');
  clientSignal.addEventListener('abort', onAbort, { once: true });
  let timer = setTimeout(() => abort('first byte timeout'), FIRST_BYTE_TIMEOUT);
  const arm = (ms, reason) => { clearTimeout(timer); timer = setTimeout(() => abort(reason), ms); };
  const cleanup = () => { clearTimeout(timer); clientSignal.removeEventListener('abort', onAbort); };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload), signal: ctl.signal });
  } catch (e) {
    cleanup();
    throw new Upstream(0, why || `network: ${e.cause?.code || e.message}`);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    cleanup();
    throw new Upstream(res.status, txt.slice(0, 500) || res.statusText,
      retryAfterS(res.headers.get('retry-after')) || retryFromBody(txt), res.status === 429 ? rpmFromBody(txt) : 0);
  }
  // Streams get an idle timer re-armed on every chunk; plain calls get one overall deadline.
  if (body.stream) arm(IDLE_TIMEOUT, 'stream idle timeout'); else arm(TIMEOUT, 'timeout');
  const raw = res.body.getReader();
  const reader = { read: async () => {
    try {
      const r = await raw.read();
      if (body.stream) arm(IDLE_TIMEOUT, 'stream idle timeout');
      return r;
    } catch (e) { throw new Upstream(0, why || e.message); }
  } };
  return { res, reader, t0, cleanup };
}

// Errors that mean "try next target". A 400 is the caller's fault and would fail everywhere,
// except when it says the prompt is too long: a model with a bigger context may still take it.
const TOO_LONG = /context|too (long|large)|maximum.*tokens|token limit|reduce the length/i;
// Some providers (Gemini) reject a bad key with 400 instead of 401. Read it as a 401.
const BAD_KEY = /api[ _-]?key|API_KEY_INVALID|unauthenticated|invalid.*(credential|token)/i;
// A 400 saying the model cannot take images or tools is not the caller's fault: another model can.
const NO_VISION = /image|vision|multimodal|content must be a string/i;
const NO_TOOLS = /\btools?\b.*(not supported|unsupported|does not support)|(not support|unsupported).*\b(tools?|function)|tool_choice/i;
const needs = (body) => ({
  vision: Array.isArray(body.messages) && body.messages.some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === 'image_url' || c?.type === 'input_image')),
  tools: Array.isArray(body.tools) && body.tools.length > 0,
});
// Capabilities learned from such errors, per target ("provider/model"), for the process lifetime.
const lacks = new Map();
const lacksFor = (id) => lacks.get(id) ?? (lacks.set(id, new Set()), lacks.get(id));
function capabilityMiss(status, message, need) {
  if (status !== 400 && status !== 422 && status !== 404) return null;
  if (need.vision && NO_VISION.test(message)) return 'vision';
  if (need.tools && NO_TOOLS.test(message)) return 'tools';
  return null;
}
// What bascule learned (capability gaps, per-minute quotas) survives restarts in state.json.
const STATE_PATH = join(HOME_DIR, 'state.json');
function loadState() {
  try {
    const st = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    for (const [id, caps] of Object.entries(st.cannot || {})) lacks.set(id, new Set(caps.filter((c) => c === 'vision' || c === 'tools')));
    for (const [hid, rpm] of Object.entries(st.rpm || {})) if (Number(rpm) > 0) h(hid).learnedRpm = Number(rpm);
  } catch {} // no state yet, or unreadable: start fresh
}
function saveState() {
  const cannot = Object.fromEntries([...lacks].filter(([, c]) => c.size).map(([id, c]) => [id, [...c]]));
  const rpm = Object.fromEntries([...health].filter(([, s]) => s.learnedRpm).map(([hid, s]) => [hid, s.learnedRpm]));
  const json = JSON.stringify({ cannot, rpm });
  if (json === saveState.last) return;
  try {
    mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STATE_PATH + '.tmp', json, { mode: 0o600 });
    renameSync(STATE_PATH + '.tmp', STATE_PATH); // atomic: a crash mid-write never leaves a torn file
    saveState.last = json;
  } catch (e) { console.error(`cannot save ${STATE_PATH}: ${e.message}`); }
}
const normalise = (status, message) => (status === 400 && BAD_KEY.test(message) ? 401 : status);
const retryable = (e) => e.status === 0 || e.status === 401 || e.status === 403 || e.status === 404
  || e.status === 408 || e.status === 409 || e.status === 413 || e.status === 429 || e.status >= 500
  || (e.status === 400 && TOO_LONG.test(e.message));
// 401/403/429 are about one key: its siblings may still work. The rest condemns the target.
const keyLevel = (e) => e.status === 401 || e.status === 403 || e.status === 429;

// ---------- cache ----------
const cache = new Map();
const cacheKey = (b) => createHash('sha256').update(JSON.stringify(b)).digest('hex');
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

// ---------- routing ----------
// Identical cacheable requests in flight share one upstream call.
const inflight = new Map();
const sleep = (ms, signal) => new Promise((ok) => {
  const t = setTimeout(ok, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); ok(); }, { once: true });
});

// Requests-per-minute budget, counted per model and key: set with `rpm` in the provider config,
// or learned from a 429 that states the quota. A target at its budget is treated as cooling,
// so bascule waits or moves on instead of provoking another 429.
function overBudget(t, k) {
  const s = h(k.hid), now = Date.now();
  s.calls = (s.calls || []).filter((x) => x > now - 60_000);
  const lim = t.provider.rpm || s.learnedRpm;
  if (!lim || s.calls.length < lim) return false;
  s.until = Math.max(s.until, s.calls[0] + 60_000);
  s.hard = true;
  return true;
}

// Tries each (target, key) pair until one answers, healthy pairs first in combo order.
// When every target is only rate limited or overloaded and one frees up within maxWaitMs,
// the request waits for it instead of failing.
async function route(res, body, { endpoint, requested, cacheable }) {
  stats.requests++;
  const t0 = Date.now();
  let targets = resolve(requested);
  if (endpoint !== '/chat/completions') targets = targets.filter((t) => t.provider.type === 'openai');
  if (!targets.length) return send(res, 404, err(`unknown model "${requested}"`, 'model_not_found'));

  const ck = cacheable && CACHE_MAX > 0 ? cacheKey({ endpoint, ...body, model: requested }) : null;
  if (ck) {
    const hit = cacheGet(ck);
    if (hit) { stats.cacheHits++; log(200, requested, 'cache', t0, 0); return send(res, 200, hit, { 'x-bascule-cache': 'hit' }); }
    const shared = inflight.get(ck);
    if (shared) {
      const out = await shared;
      if (out) { stats.cacheHits++; log(200, requested, 'shared', t0, 0); return send(res, 200, out, { 'x-bascule-cache': 'shared' }); }
    }
  }
  let share = null;
  if (ck && !inflight.has(ck)) {
    let resolveShare;
    inflight.set(ck, new Promise((r) => { resolveShare = r; }));
    share = (out) => { inflight.delete(ck); resolveShare(out); };
  }
  try {
    const out = await attempt(res, body, { endpoint, requested, targets, ck, t0 });
    share?.(out);
  } catch (e) { share?.(null); throw e; }
}

async function attempt(res, body, { endpoint, requested, targets: allTargets, ck, t0 }) {
  let targets = allTargets;
  const clientAbort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) clientAbort.abort(); });
  const deadline = t0 + MAX_WAIT;
  const permanent = new Set(); // targets that waiting cannot fix (bad request, unknown model...)
  const errors = [];
  let tries = 0, lastStatus = 503, capError = null;
  // Skip targets known to lack what this request needs, unless that would leave none at all.
  const need = needs(body);
  const able = targets.filter((t) => ![...lacksFor(t.id)].some((c) => need[c]));
  if (able.length) targets = able;

  for (;;) {
    const now = Date.now();
    const pairs = targets.filter((t) => !permanent.has(t.id))
      .flatMap((t) => keysFor(t, endpoint).map((k) => ({ t, k })));
    for (const p of pairs) overBudget(p.t, p.k);
    // A cooling pair that frees up before the deadline is waited for. One that stays cool past
    // it is tried anyway as a last resort, unless its delay is certain (stated by the provider,
    // over its known quota, dead key): that call could only fail and burn quota.
    const coolUntil = (p) => h(p.k.hid).until;
    const ready = pairs.filter((p) => coolUntil(p) <= now || (coolUntil(p) > deadline && !h(p.k.hid).hard));
    ready.sort((a, b) => (coolUntil(a) > now) - (coolUntil(b) > now));
    const deadTargets = new Set();

    for (const { t, k } of ready) {
      if (deadTargets.has(t.id) || permanent.has(t.id)) continue;
      if (clientAbort.signal.aborted) return null;
      if (tries++) stats.fallbacks++;
      h(k.hid).calls.push(Date.now());
      const head = { 'x-bascule-target': t.id };
      let up;
      try {
        up = await callOnce(t, k, body, clientAbort.signal, endpoint);
        let out = null;
        if (body.stream) await pipeStream(up, t, res, head);
        else {
          const raw = await readJson(up.reader);
          out = t.provider.type === 'anthropic' ? fromAnthropic(raw, t.model) : raw;
          addUsage(out.usage);
          if (ck) cacheSet(ck, out);
          send(res, 200, out, head);
        }
        success(k.hid, Date.now() - up.t0);
        log(200, requested, t.id, t0, tries - 1);
        return out;
      } catch (e) {
        if (clientAbort.signal.aborted) return null;
        const status = e instanceof Upstream ? normalise(e.status, String(e.message)) : 0;
        errors.push(`${t.id}: ${status || 'ERR'} ${String(e.message).slice(0, 160)}`);
        cooldown(k.hid, status, e.retryAfter);
        if (e.rpm) h(k.hid).learnedRpm = e.rpm;
        if (res.headersSent) { // mid-stream: bytes already left, report in-band and stop
          res.end(`data: ${JSON.stringify(err(`upstream ${t.id} failed mid-stream: ${e.message}`, 'upstream_error'))}\n\n`);
          log(502, requested, t.id, t0, tries - 1);
          return null;
        }
        const miss = capabilityMiss(status, String(e.message), need);
        if (miss) {
          lacksFor(t.id).add(miss);
          h(k.hid).until = 0; h(k.hid).fails = 0; // the target is fine, just not for this request
          permanent.add(t.id);
          capError = { status, message: `no target could handle ${miss === 'vision' ? 'images' : 'tools'}:\n${errors.join('\n')}` };
          continue;
        }
        if (!retryable({ status, message: String(e.message) })) {
          log(status, requested, t.id, t0, tries - 1);
          send(res, status, err(e.message, 'upstream_error'));
          return null;
        }
        lastStatus = status === 429 ? 429 : 503;
        if (status === 404 || status === 400 || status === 413) permanent.add(t.id);
        else if (!keyLevel({ status })) deadTargets.add(t.id);
      } finally { up?.cleanup(); }
    }

    // Nothing answered. Wait for the soonest pair that frees up before the deadline, if any.
    const soonest = Math.min(...pairs.filter((p) => !permanent.has(p.t.id)).map(coolUntil).filter((u) => u <= deadline));
    const wait = soonest - Date.now();
    if (!Number.isFinite(soonest) || clientAbort.signal.aborted) break;
    if (wait > 0) await sleep(wait, clientAbort.signal);
    if (clientAbort.signal.aborted) return null;
  }
  stats.failures++;
  // Tell the client when the first target frees up; OpenAI SDKs honour retry-after on a 429.
  const free = Math.min(...targets.flatMap((t) => keysFor(t, endpoint).map((k) => h(k.hid).until)));
  const retryIn = Math.ceil((free - Date.now()) / 1000);
  const headers = retryIn > 0 && Number.isFinite(retryIn) ? { 'retry-after': String(retryIn) } : {};
  if (!tries) lastStatus = 429; // nothing was even tried: every target is at a known limit
  if (capError && errors.every((x) => / 40[04] | 422 /.test(x))) { // only capability misses: the request itself is the issue
    log(capError.status, requested, 'none', t0, Math.max(tries - 1, 0));
    send(res, 400, err(capError.message, 'unsupported_input'));
    return null;
  }
  log(lastStatus, requested, 'none', t0, Math.max(tries - 1, 0));
  send(res, lastStatus, err(`all targets failed:\n${errors.join('\n') || `every target is rate limited; first one frees up in ${retryIn}s`}`, 'all_targets_failed'), headers);
  return null;
}

async function readJson(reader) {
  const chunks = [];
  for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(value); }
  const s = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(s); } catch { throw new Upstream(502, `invalid JSON from upstream: ${s.slice(0, 120)}`); }
}

async function pipeStream(up, t, res, head) {
  const gen = t.provider.type === 'anthropic' ? anthropicStream(up.reader, t.model, addUsage) : passthrough(up.reader, addUsage);
  // Pull the first chunk before committing headers: allows fallback if upstream dies instantly.
  const first = await gen.next();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
    connection: 'keep-alive', 'x-accel-buffering': 'no', ...head });
  if (!first.done) res.write(first.value);
  for await (const s of gen) {
    if (res.destroyed) return;
    if (!res.write(s)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
  }
  res.end();
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
    coolingForS: s.until > now ? Math.ceil((s.until - now) / 1000) : 0, ...(s.learnedRpm && { learnedRpm: s.learnedRpm }) };
  const cannot = Object.fromEntries([...lacks].filter(([, c]) => c.size).map(([id, c]) => [id, [...c]]));
  return { version: VERSION, uptimeS: Math.round(process.uptime()), providers: Object.keys(providers), cannot,
    cacheSize: cache.size, ...stats, targets };
}

function log(code, model, target, t0, fallbacks) {
  if (LOG) console.log(`${new Date().toISOString()} ${code} ${model} -> ${target} ${Date.now() - t0}ms${fallbacks ? ` (${fallbacks} fallback${fallbacks > 1 ? 's' : ''})` : ''}`);
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
  // Compare digests: equal length always, so neither length nor content leaks through timing.
  const d = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(d(got), d(API_KEY));
}
class TooLarge extends Error {}
function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { ko(new TooLarge()); req.pause(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', ko);
  });
}

// ---------- doctor & status ----------
const mask = (k) => (k ? `…${k.slice(-4)}` : 'no key');
// Public key prefixes: enough to spot a key pasted on the wrong line of .env.
const KEY_PREFIXES = [['sk-or-', 'openrouter'], ['sk-ant-', 'anthropic'], ['gsk_', 'groq'], ['AIza', 'gemini'],
  ['csk-', 'cerebras'], ['sk-proj-', 'openai'], ['sk-svcacct-', 'openai']];
const keyOwner = (k) => KEY_PREFIXES.find(([pre]) => k.startsWith(pre))?.[1];
async function doctor(deep) {
  let working = 0;
  for (const name of Object.keys(cfg.providers || {})) {
    const p = providers[name];
    if (!p) { console.log(`  -  ${name}: no key set, skipped`); continue; }
    for (const [i, key] of p.keys.entries()) {
      const url = p.type === 'anthropic' ? `${p.baseUrl}/v1/models` : `${p.baseUrl}/models`;
      const headers = p.type === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...p.headers }
        : { ...(key ? { authorization: `Bearer ${key}` } : {}), ...p.headers };
      let r, listed = null;
      try {
        r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (r.ok) listed = new Set(((await r.json()).data || []).map((m) => String(m.id).replace(/^models\//, '')));
      } catch (e) {
        console.log(`  ✗  ${name} key ${i + 1} (${mask(key)}): unreachable (${e.cause?.code || e.message})`);
        continue;
      }
      if (!r.ok) {
        const why = r.status === 401 || r.status === 403 || (r.status === 400 && BAD_KEY.test(await r.text().catch(() => ''))) ? 'invalid key' : `HTTP ${r.status}`;
        const owner = keyOwner(key);
        const hint = owner && owner !== name && !p.baseUrl.includes(owner) ? `  <- this looks like a ${owner} key: move it to the ${owner.toUpperCase()}_API_KEY line` : '';
        console.log(`  ✗  ${name} key ${i + 1} (${mask(key)}): ${why}${hint}`);
        continue;
      }
      working++;
      console.log(`  ✓  ${name} key ${i + 1} (${mask(key)}): reachable, ${listed.size} models available`);
      for (const m of p.models) {
        let line = listed.has(m) ? 'listed' : 'NOT LISTED (retired or misspelled?)';
        if (deep) {
          try {
            const up = await callOnce({ provider: p, model: m, id: `${name}/${m}` }, { key }, { messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 },
              new AbortController().signal, '/chat/completions');
            await readJson(up.reader); up.cleanup();
            line += ', answers';
          } catch (e) {
            line += `, FAILS: ${e.status || ''} ${String(e.message).replace(/\s+/g, ' ').slice(0, 90)}`;
          }
        }
        console.log(`       ${m}: ${line}`);
      }
    }
  }
  for (const [name, combo] of Object.entries(cfg.combos || {})) {
    const targets = Array.isArray(combo) ? combo : combo.targets || [];
    const active = targets.filter((t) => parseTarget(t));
    console.log(`  combo ${name}: ${active.length}/${targets.length} targets active${active.length ? '' : '  <- unusable, add a key'}`);
  }
  if (!deep) console.log('\n  (listing only: run "bascule doctor --deep" to send one tiny request per model)');
  return working;
}

async function printStatus() {
  const url = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}/stats`;
  let st;
  try {
    const r = await fetch(url, { headers: API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    st = await r.json();
  } catch (e) { console.error(`no router answering on ${url} (${e.cause?.code || e.message}). Start it with: bascule`); return false; }
  console.log(`bascule ${st.version}, up ${st.uptimeS}s, providers: ${st.providers.join(', ')}`);
  console.log(`requests ${st.requests}  cache hits ${st.cacheHits}  fallbacks ${st.fallbacks}  failures ${st.failures}  tokens ${st.tokens.prompt} in / ${st.tokens.completion} out`);
  const rows = Object.entries(st.targets).sort(([a], [b]) => a.localeCompare(b));
  if (rows.length) {
    const w = Math.max(...rows.map(([id]) => id.length));
    for (const [id, t] of rows) {
      const state = t.coolingForS ? `cooling ${t.coolingForS}s` : 'ready';
      console.log(`  ${id.padEnd(w)}  ok ${String(t.ok).padStart(5)}  err ${String(t.err).padStart(4)}  ${String(t.latencyMs).padStart(6)} ms  ${state}${t.learnedRpm ? `  limit ${t.learnedRpm}/min` : ''}`);
    }
  }
  return true;
}

const ENDPOINTS = { '/v1/chat/completions': '/chat/completions', '/v1/embeddings': '/embeddings' };

if (arg === 'doctor') process.exit((await doctor(process.argv.includes('--deep'))) ? 0 : 1);
if (arg === 'status') process.exit((await printStatus()) ? 0 : 1);

const server = http.createServer(async (req, res) => {
  const path = req.url.split('?')[0].replace(/\/+$/, '') || '/';
  // Any web page can fire requests at localhost. Only listed origins get through, otherwise
  // a malicious site could spend the owner's quotas even without reading the answer.
  const origin = req.headers.origin;
  if (origin) {
    if (!CORS.includes(origin) && !CORS.includes('*')) return send(res, 403, err(`origin ${origin} not allowed (config: corsOrigins)`, 'forbidden_origin'));
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-expose-headers', 'x-bascule-target, x-bascule-cache');
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-headers': 'authorization,content-type,x-api-key', 'access-control-allow-methods': 'GET,POST' });
    return res.end();
  }
  if (path === '/health') return send(res, 200, { ok: true });
  if (!authed(req)) return send(res, 401, err('invalid api key', 'unauthorized'));
  try {
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return send(res, 200, listModels());
    if (req.method === 'GET' && path === '/stats') return send(res, 200, status());
    const endpoint = ENDPOINTS[path] || ENDPOINTS['/v1' + path];
    if (req.method === 'POST' && endpoint) {
      // A JSON content type cannot be sent by a plain HTML form, which closes the no-preflight CSRF path.
      if (!/^application\/json\b/i.test(req.headers['content-type'] || ''))
        return send(res, 415, err('content-type must be application/json', 'unsupported_media_type'));
      let body;
      try { body = JSON.parse(await readBody(req)); }
      catch (e) {
        if (e instanceof TooLarge) { res.setHeader('connection', 'close'); return send(res, 413, err('body too large (32 MB max)', 'request_too_large')); }
        return send(res, 400, err(`bad json: ${e.message}`, 'invalid_request'));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, err('body must be a JSON object', 'invalid_request'));
      const requested = typeof body.model === 'string' && body.model ? body.model : cfg.defaultModel || '';
      if (endpoint === '/chat/completions') {
        if (!Array.isArray(body.messages) || !body.messages.length) return send(res, 400, err('messages must be a non-empty array', 'invalid_request'));
        compact(body);
        return await route(res, body, { endpoint, requested,
          cacheable: !body.stream && (body.temperature === 0 || cfg.cache?.always === true) });
      }
      // Embeddings never stream; drop the field rather than send it (Gemini rejects unknown fields).
      const { stream: _ignored, ...rest } = body;
      return await route(res, rest, { endpoint, requested, cacheable: true });
    }
    send(res, 404, err('not found', 'not_found'));
  } catch (e) {
    console.error(e);
    send(res, 500, err(e.message, 'internal'));
  }
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0; // long generations must not be cut by Node's default 5 min limit
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} already in use (set BASCULE_PORT)` : e.message);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`bascule ${VERSION} on http://${HOST}:${PORT}/v1  providers: ${Object.keys(providers).join(', ') || '(none — add keys to .env)'}`);
  console.log(`config: ${CONFIG_PATH}${API_KEY ? '' : '  (no BASCULE_KEY: any local program can use it)'}`);
});
function shutdown() {
  saveState();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown);
process.on('SIGHUP', () => reload('SIGHUP'));
loadState();
setInterval(saveState, 30_000).unref();
// Editors save in bursts (truncate, write, rename): wait for the file to settle before reloading.
let reloadTimer;
for (const f of [CONFIG_PATH, ENV_PATH].filter(Boolean)) {
  watchFile(f, { interval: 1000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(`${f} changed`), 300);
  }).unref?.();
}

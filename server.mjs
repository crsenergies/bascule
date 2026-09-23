#!/usr/bin/env node
// Bascule — lean OpenAI-compatible AI router. Zero dependencies, Node >= 20.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync, watchFile, renameSync } from 'node:fs';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

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
  bascule discover  find retired models and new free ones (add --apply to update the config)
  bascule dashboard open the live dashboard of the running router in the browser

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
if (arg && !['doctor', 'status', 'dashboard', 'discover'].includes(arg)) { console.error(`unknown argument "${arg}" (try --help)`); process.exit(2); }

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
let API_KEY, CORS, TIMEOUT, FIRST_BYTE_TIMEOUT, IDLE_TIMEOUT, CACHE_MAX, CACHE_TTL, LOG, MAX_WAIT;
function applySettings() {
  API_KEY = process.env.BASCULE_KEY || cfg.apiKey || '';
  CORS = [].concat(cfg.corsOrigins ?? []);       // browser origins allowed to call; none by default
  TIMEOUT = cfg.timeoutMs ?? 120_000;            // whole non-streaming call
  FIRST_BYTE_TIMEOUT = cfg.firstByteTimeoutMs ?? 30_000;
  IDLE_TIMEOUT = cfg.idleTimeoutMs ?? 60_000;    // max silence inside a stream
  CACHE_MAX = cfg.cache?.maxEntries ?? 500;
  CACHE_TTL = cfg.cache?.ttlMs ?? 10 * 60_000;
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
      streamUsage: p.streamUsage !== false, rpm: Number(p.rpm) || 0, rr: 0,
      params: p.params && typeof p.params === 'object' ? p.params : {}, minMaxTokens: Number(p.minMaxTokens) || 0 };
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
    warmUp();
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
  if (status === 402) ms = 6 * 3600_000; // no credit on this account: nothing changes until someone pays
  s.until = Date.now() + ms;
  // A delay stated by the provider (or a dead key) is certain; a guessed backoff is not.
  s.hard = Boolean(retryAfter) || status === 401 || status === 402 || status === 403;
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
    const d = parseJson(ev);
    if (!d) continue;
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

// Splits an SSE text stream into the data payloads of its complete events. Line endings are
// normalised on the joined buffer: a CRLF can straddle two chunks, so a trailing lone CR waits.
function sseSplitter() {
  let buf = '';
  return (text) => {
    buf = (buf + text).replace(/\r\n|\r(?!$)/g, '\n');
    const out = [];
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      buf = buf.slice(i + 2);
      if (data && data !== '[DONE]') out.push(data);
    }
    return out;
  };
}
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

async function* sseEvents(reader) {
  const dec = new TextDecoder(), split = sseSplitter();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    yield* split(dec.decode(value, { stream: true }));
  }
}

// OpenAI-compatible SSE is forwarded untouched, except that nothing is committed to the client
// until a meaningful event arrives (text, tool call or finish). Providers may answer 200 and then
// put the error in the stream, after a content-free first chunk (Groq does this for tool calls
// it rejects): such an error must still fall back to the next target.
// In-stream error codes are numbers or names (Gemini: "RESOURCE_EXHAUSTED"); map names to HTTP statuses.
const CODE_NAMES = { RESOURCE_EXHAUSTED: 429, rate_limit_exceeded: 429, UNAVAILABLE: 503, overloaded_error: 503, tool_use_failed: 400,
  INVALID_ARGUMENT: 400, UNAUTHENTICATED: 401, PERMISSION_DENIED: 403, NOT_FOUND: 404 };
const inBandError = (d) => {
  const e = d.error, n = Number(e.code);
  const status = Number.isInteger(n) && n >= 400 ? n : CODE_NAMES[e.code] || CODE_NAMES[e.status] || CODE_NAMES[e.type] || 502;
  return new Upstream(status, e.message || JSON.stringify(e), retryFromBody(JSON.stringify(d)));
};
async function* passthrough(reader, onUsage) {
  const dec = new TextDecoder(), split = sseSplitter();
  let held = '', committed = false, usage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const s = dec.decode(value, { stream: true });
    for (const data of split(s)) {
      // Bytes are forwarded as received; once committed, only events that can matter are parsed.
      if (committed && !data.includes('"usage"') && !data.includes('"error"')) continue;
      const d = parseJson(data);
      if (d?.error && !d.choices) throw inBandError(d); // after commit: counted as a mid-stream failure
      if (d?.usage) usage = d.usage;
      const c = d?.choices?.[0];
      if (c && (c.delta?.content || c.delta?.tool_calls)) committed = true;
    }
    if (committed) { yield held + s; held = ''; } else held += s;
  }
  // Ended without a single word or tool call: an empty answer (free routers produce these),
  // so the next target gets a chance instead of the client receiving nothing.
  if (!committed) throw new Upstream(502, held.trim() ? 'empty answer' : 'empty stream');
  if (usage) onUsage(usage);
}

// ---------- inbound Anthropic Messages API ----------
// Clients that speak Anthropic's format (Claude Code, the Anthropic SDKs) are translated to the
// internal OpenAI format on the way in, and back on the way out, so every provider serves them.

// Anthropic request -> OpenAI chat request
function fromAnthropicRequest(a) {
  const messages = [];
  const textOf = (c) => (typeof c === 'string' ? c : (c || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n'));
  const sys = textOf(a.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of a.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      const tool_calls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({ id: b.id, type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (text || tool_calls.length) messages.push({ role: 'assistant', content: text || null, ...(tool_calls.length && { tool_calls }) });
      continue;
    }
    // Tool results must directly follow the assistant turn that asked for them, before any new user text.
    for (const b of blocks.filter((b) => b?.type === 'tool_result')) {
      const content = textOf(b.content) || (typeof b.content === 'string' ? b.content : '');
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + (content || '(empty)') });
    }
    const parts = [];
    for (const b of blocks) {
      if (b?.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
      else if (b?.type === 'image') {
        const src = b.source || {};
        const url = src.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : src.url;
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      } else if (b?.type === 'document' && b.source?.type === 'text') parts.push({ type: 'text', text: b.source.data });
    }
    if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  const out = { model: a.model, messages, max_tokens: a.max_tokens, stream: Boolean(a.stream) };
  for (const k of ['temperature', 'top_p']) if (a[k] !== undefined) out[k] = a[k];
  if (a.stop_sequences?.length) out.stop = a.stop_sequences;
  // Server tools (web search...) have no input_schema and only exist on Anthropic's side.
  const tools = (a.tools || []).filter((t) => t?.input_schema);
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const tc = a.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'none') out.tool_choice = 'none';
    else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return out;
}

const STOP_TO_ANTHROPIC = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };
const toolId = (id) => (id && /^[\w-]+$/.test(id) ? id : 'toolu_' + randomBytes(12).toString('hex'));

// OpenAI chat response -> Anthropic message
function toAnthropicMessage(o, model) {
  const c = o.choices?.[0] || {}, m = c.message || {};
  const content = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
    // Anthropic requires an object; some models emit an array or a bare value.
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = { value: input };
    content.push({ type: 'tool_use', id: toolId(tc.id), name: tc.function?.name, input });
  }
  const u = o.usage || {};
  return { id: 'msg_' + String(o.id || randomBytes(12).toString('hex')).replace(/\W/g, ''), type: 'message', role: 'assistant', model,
    content, stop_reason: STOP_TO_ANTHROPIC[c.finish_reason] || 'end_turn', stop_sequence: null,
    usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
}

// OpenAI SSE (as produced by pipeStream's generators) -> Anthropic SSE events.
async function* toAnthropicStream(gen, model) {
  const ev = (type, d) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const split = sseSplitter();
  let started = false, block = -1, open = null, finish = null, usage = null;
  const tools = new Map(); // openai tool index -> anthropic block index
  const close = () => (open ? (open = null, ev('content_block_stop', { index: block })) : '');
  for await (const raw of gen) {
    if (!started) {
      started = true;
      yield ev('message_start', { message: { id: 'msg_' + randomBytes(12).toString('hex'), type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    }
    let out = '';
    for (const data of split(raw)) {
      const d = parseJson(data);
      if (!d) continue;
      if (d.usage) usage = d.usage;
      const c = d.choices?.[0];
      if (!c) continue;
      const delta = c.delta || {};
      if (delta.content) {
        if (open !== 'text') { out += close(); block++; open = 'text'; out += ev('content_block_start', { index: block, content_block: { type: 'text', text: '' } }); }
        out += ev('content_block_delta', { index: block, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!tools.has(k)) {
          out += close(); block++; open = 'tool'; tools.set(k, block);
          out += ev('content_block_start', { index: block, content_block: { type: 'tool_use', id: toolId(tc.id), name: tc.function?.name || '', input: {} } });
        }
        if (tc.function?.arguments && tools.get(k) === block)
          out += ev('content_block_delta', { index: block, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
      if (c.finish_reason) finish = c.finish_reason;
    }
    if (out) yield out;
  }
  if (!started) throw new Upstream(502, 'empty stream');
  yield close() + ev('message_delta', { delta: { stop_reason: STOP_TO_ANTHROPIC[finish] || 'end_turn', stop_sequence: null },
    usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: usage?.completion_tokens || 0 } }) + ev('message_stop', {});
}

// Claude Code asks for claude-* models by name. Aliases map such names onto combos or targets.
function aliasFor(model) {
  for (const [pattern, target] of Object.entries(cfg.aliases || {})) {
    const re = new RegExp('^' + pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (re.test(model)) return target;
  }
  return null;
}

// ---------- upstream call ----------
// Auth and version headers for a provider call.
const authHeaders = (p, key) => (p.type === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', ...p.headers }
  : { ...(key ? { authorization: `Bearer ${key}` } : {}), ...p.headers });

function buildRequest(t, key, body, endpoint) {
  const p = t.provider;
  // Reasoning models spend part of max_tokens thinking before they write; a small client budget
  // can leave nothing for the answer. minMaxTokens raises the floor for such providers.
  if (p.minMaxTokens && endpoint === '/chat/completions') {
    const k = body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
    if (body[k] !== undefined && body[k] < p.minMaxTokens) body = { ...body, [k]: p.minMaxTokens };
  }
  if (p.type === 'anthropic') {
    return { url: `${p.baseUrl}/v1/messages`, payload: toAnthropic(body, t.model),
      headers: authHeaders(p, key) };
  }
  // Provider defaults (e.g. reasoning_effort) never override what the client asked for.
  const payload = { ...(endpoint === '/chat/completions' ? p.params : {}), ...body, model: t.model };
  // Some OpenAI-compatible APIs (Groq) only accept string content. A text-only parts array
  // means exactly the same thing as its joined text, so send that.
  if (Array.isArray(body.messages) && body.messages.some((m) => Array.isArray(m?.content)))
    payload.messages = body.messages.map((m) => (Array.isArray(m?.content) && m.content.every((c) => c?.type === 'text')
      ? { ...m, content: m.content.map((c) => c.text ?? '').join('\n') } : m));
  if (payload.stream && p.streamUsage) payload.stream_options = { include_usage: true, ...payload.stream_options };
  return { url: `${p.baseUrl}${endpoint}`, payload, headers: authHeaders(p, key) };
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
// OpenRouter's daily free quota gives the reset instant ("X-RateLimit-Reset": epoch ms).
function retryFromBody(txt) {
  const reset = txt.match(/"X-RateLimit-Reset"\s*:\s*"?(\d{13})/i);
  if (reset) return Math.max(0, (Number(reset[1]) - Date.now()) / 1000);
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

// Upstream transport. Node's fetch drops idle connections after about 4 s, so every request after
// a pause paid a new TLS handshake (100-200 ms measured). These agents keep sockets open for as
// long as the provider allows (45 s+ on Groq, Gemini and OpenRouter).
const agents = {
  'http:': new http.Agent({ keepAlive: true, keepAliveMsecs: 15_000, scheduling: 'lifo' }),
  'https:': new https.Agent({ keepAlive: true, keepAliveMsecs: 15_000, scheduling: 'lifo' }),
};
// Minimal fetch-like wrapper over http(s).request: status, headers.get, text() and a chunk reader.
function request(url, { headers, body, signal }) {
  return new Promise((ok, ko) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'POST', agent: agents[u.protocol], headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' || enc === 'x-gzip' ? res.pipe(zlib.createGunzip()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
        : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      if (stream !== res) res.on('error', (e) => stream.destroy(e));
      const it = stream[Symbol.asyncIterator]();
      ok({
        status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, statusText: res.statusMessage,
        headers: { get: (n) => { const v = res.headers[n.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } },
        reader: { read: async () => { const r = await it.next(); return r.done ? { done: true } : { done: false, value: r.value }; } },
        text: async () => { const parts = []; for await (const c of stream) parts.push(c); return Buffer.concat(parts).toString('utf8'); },
      });
    });
    const onAbort = () => req.destroy(new Error('aborted'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    req.on('error', ko);
    req.on('close', () => signal.removeEventListener('abort', onAbort));
    req.setNoDelay(true);
    req.end(body);
  });
}

// Open a kept-alive connection to every provider ahead of the first real request.
function warmUp() {
  for (const p of Object.values(providers)) {
    const u = new URL(p.type === 'anthropic' ? `${p.baseUrl}/v1/models` : `${p.baseUrl}/models`);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get(u, { agent: agents[u.protocol], headers: authHeaders(p, p.keys[0]), timeout: 10_000 }, (res) => res.resume())
      .on('timeout', function () { this.destroy(); }).on('error', () => {});
  }
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
    res = await request(url, { headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, br', ...headers },
      body: JSON.stringify(payload), signal: ctl.signal });
  } catch (e) {
    cleanup();
    throw new Upstream(0, why || `network: ${e.code || e.cause?.code || e.message}`);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    cleanup();
    throw new Upstream(res.status, txt.slice(0, 500) || res.statusText,
      retryAfterS(res.headers.get('retry-after')) || retryFromBody(txt), res.status === 429 ? rpmFromBody(txt) : 0);
  }
  // Streams get an idle timer re-armed on every chunk; plain calls get one overall deadline.
  if (body.stream) arm(IDLE_TIMEOUT, 'stream idle timeout'); else arm(TIMEOUT, 'timeout');
  const raw = res.reader;
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
    for (const [hid, max] of Object.entries(st.maxTokens || {})) if (Number(max) > 0) h(hid).maxTokens = Number(max);
    if (st.spend?.day === today() && Number.isFinite(st.spend.usd)) spend = { day: st.spend.day, usd: st.spend.usd, byTarget: st.spend.byTarget || {} };
  } catch {} // no state yet, or unreadable: start fresh
}
function saveState() {
  const cannot = Object.fromEntries([...lacks].filter(([, c]) => c.size).map(([id, c]) => [id, [...c]]));
  const rpm = Object.fromEntries([...health].filter(([, s]) => s.learnedRpm).map(([hid, s]) => [hid, s.learnedRpm]));
  const maxTokens = Object.fromEntries([...health].filter(([, s]) => s.maxTokens).map(([hid, s]) => [hid, s.maxTokens]));
  const json = JSON.stringify({ cannot, rpm, maxTokens, spend });
  if (json === saveState.last) return;
  try {
    mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STATE_PATH + '.tmp', json, { mode: 0o600 });
    renameSync(STATE_PATH + '.tmp', STATE_PATH); // atomic: a crash mid-write never leaves a torn file
    saveState.last = json;
  } catch (e) { console.error(`cannot save ${STATE_PATH}: ${e.message}`); }
}
// "Request too large ... (TPM): Limit 8000, Requested 30082" (Groq, OpenAI) names the largest request
// the target takes. It is about this request's size, not the key's health.
function sizeLimit(status, message) {
  if (status !== 413 && status !== 429 && status !== 400) return 0;
  const m = /too large|too long|maximum context/i.test(message) && message.match(/Limit:?\s*(\d+)[\s\S]{0,40}?Requested:?\s*(\d+)/i);
  return m && Number(m[2]) > Number(m[1]) ? Number(m[1]) : 0;
}
// Rough token count, enough to compare with a learned limit: about 4 characters per token.
const estimateTokens = (body) => Math.ceil(JSON.stringify([body.messages, body.tools]).length / 4) + (body.max_tokens || body.max_completion_tokens || 0);
const normalise = (status, message) => (status === 400 && BAD_KEY.test(message) ? 401 : status);
// The model produced something the provider itself rejected (Groq: invalid tool call). Another
// model may do better; nothing is wrong with the request or the target in general.
const GENERATION_FAILED = /tool_use_failed|tool call validation failed|failed to (call|parse) (a )?(function|tool)|output_parse_failed/i;
// 402 (payment required) is about one account, like a bad key: its sibling keys and targets may work.
const retryable = (e) => e.status === 0 || (e.status === 400 && GENERATION_FAILED.test(e.message)) || e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404
  || e.status === 408 || e.status === 409 || e.status === 413 || e.status === 429 || e.status >= 500
  || (e.status === 400 && TOO_LONG.test(e.message));
// 401/403/429 are about one key: its siblings may still work. The rest condemns the target.
const keyLevel = (e) => e.status === 401 || e.status === 402 || e.status === 403 || e.status === 429;

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
const stats = { requests: 0, cacheHits: 0, fallbacks: 0, hedges: 0, failures: 0, tokens: { prompt: 0, completion: 0 } };
// Answers per combo and target: the dashboard animates each new one along its line.
const served = {};
// Per-minute activity for the last hour, for the dashboard chart.
const timeline = [];
function tally(kind, ms) {
  const m = Math.floor(Date.now() / 60_000);
  let b = timeline.at(-1);
  if (!b || b.m !== m) { timeline.push(b = { m, ok: 0, rerouted: 0, failed: 0, ms: 0, n: 0 }); if (timeline.length > 60) timeline.shift(); }
  b[kind]++;
  if (ms !== undefined) { b.ms += ms; b.n++; }
}
const addUsage = (u, t) => {
  if (!u) return;
  stats.tokens.prompt += u.prompt_tokens || 0; stats.tokens.completion += u.completion_tokens || 0;
  if (t) charge(t, u);
};

// ---------- costs ----------
// Prices come from config "prices": { "provider/model" or "provider/*": [input, output] }, in US
// dollars per million tokens. Unpriced targets count as free. Today's spend survives restarts.
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time
let spend = { day: today(), usd: 0, byTarget: {} };
function priceOf(t) {
  const p = cfg.prices?.[t.id] ?? cfg.prices?.[`${t.provider.name}/*`];
  const [i, o] = Array.isArray(p) ? p : p && typeof p === 'object' ? [p.input, p.output] : [];
  return Number(i) > 0 || Number(o) > 0 ? { input: Number(i) || 0, output: Number(o) || 0 } : null;
}
function rollover() { if (spend.day !== today()) spend = { day: today(), usd: 0, byTarget: {} }; }
function charge(t, u) {
  const p = priceOf(t);
  if (!p) return;
  rollover();
  const usd = ((u.prompt_tokens || 0) * p.input + (u.completion_tokens || 0) * p.output) / 1e6;
  spend.usd += usd;
  spend.byTarget[t.id] = (spend.byTarget[t.id] || 0) + usd;
}
const dailyBudget = () => Number(cfg.budget?.dailyUsd) || 0;
// Once today's spend reaches the budget, only free targets are used until midnight.
function capped() { rollover(); return dailyBudget() > 0 && spend.usd >= dailyBudget(); }

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
  if (!targets.length && aliasFor(requested)) targets = resolve(aliasFor(requested));
  if (endpoint !== '/chat/completions') targets = targets.filter((t) => t.provider.type === 'openai');
  if (!targets.length) return send(res, 404, err(`unknown model "${requested}"`, 'model_not_found'));

  const ck = cacheable && CACHE_MAX > 0 ? cacheKey({ endpoint, ...body, model: requested }) : null;
  if (ck) {
    const hit = cacheGet(ck);
    if (hit) { stats.cacheHits++; tally('ok'); log(200, requested, 'cache', t0, 0); return send(res, 200, shape(res, hit, requested), { 'x-bascule-cache': 'hit' }); }
    const shared = inflight.get(ck);
    if (shared) {
      const out = await shared;
      if (out) { stats.cacheHits++; tally('ok'); log(200, requested, 'shared', t0, 0); return send(res, 200, shape(res, out, requested), { 'x-bascule-cache': 'shared' }); }
    }
  }
  let share = null;
  if (ck && !inflight.has(ck)) {
    let resolveShare;
    inflight.set(ck, new Promise((r) => { resolveShare = r; }));
    share = (out) => { inflight.delete(ck); resolveShare(out); };
  }
  try {
    const combo = Object.hasOwn(cfg.combos || {}, requested) ? cfg.combos[requested] : cfg.combos?.[aliasFor(requested)];
    const own = combo && !Array.isArray(combo) ? combo.hedgeMs : undefined;
    const hedgeMs = Number(own ?? cfg.hedgeMs) || 0;
    const out = await attempt(res, body, { endpoint, requested, targets, ck, t0, hedgeMs });
    share?.(out);
  } catch (e) { share?.(null); throw e; }
}

// Hedged call: if the first target has not answered within hedgeMs, the next one is started in
// parallel and the first to answer wins; the other is cancelled. Cuts the tail latency of a slow
// or overloaded provider at the price of an occasional duplicate call.
async function hedgedCall(a, b, body, signal, endpoint, hedgeMs) {
  const start = (pair) => {
    const ctl = new AbortController();
    const relay = () => ctl.abort();
    signal.addEventListener('abort', relay, { once: true });
    const p = callOnce(pair.t, pair.k, body, ctl.signal, endpoint)
      .then((up) => ({ pair, up }), (error) => ({ pair, error }))
      .finally(() => signal.removeEventListener('abort', relay));
    return { pair, p, ctl };
  };
  const A = start(a);
  let timer;
  const fired = new Promise((r) => { timer = setTimeout(r, hedgeMs); });
  const first = await Promise.race([A.p, fired.then(() => null)]);
  if (first) { clearTimeout(timer); return { ...first, others: [] }; }
  stats.hedges++;
  const B = start(b);
  const racers = [A, B];
  const failures = [];
  // First success wins; a failure just waits for the other racer.
  const pending = new Set(racers);
  while (pending.size) {
    const r = await Promise.race([...pending].map((x) => x.p.then((v) => ({ x, v }))));
    pending.delete(r.x);
    if (r.v.up) {
      for (const other of pending) {
        other.ctl.abort();
        other.p.then((o) => o.up?.cleanup()); // it may still resolve after the abort
      }
      return { pair: r.v.pair, up: r.v.up, others: failures };
    }
    failures.push(r.v);
  }
  // Both failed: report the primary's error, the secondary's one on the side.
  const primary = failures.find((f) => f.pair === a) || failures[0];
  return { pair: primary.pair, error: primary.error, others: failures.filter((f) => f !== primary) };
}

async function attempt(res, body, { endpoint, requested, targets: allTargets, ck, t0, hedgeMs = 0 }) {
  let targets = allTargets;
  const clientAbort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) clientAbort.abort(); });
  const deadline = t0 + MAX_WAIT;
  const permanent = new Set(); // targets that waiting cannot fix (bad request, unknown model...)
  const errors = [];
  let tries = 0, lastStatus = 503, capError = null;
  // Skip targets known to lack what this request needs, unless that would leave none at all.
  if (capped()) {
    targets = targets.filter((t) => !priceOf(t));
    if (!targets.length) {
      stats.failures++; tally('failed');
      log(402, requested, 'none', t0, 0);
      send(res, 402, err(`daily budget of $${dailyBudget()} reached: only free targets are used until midnight, and this model has none`, 'budget_exceeded'));
      return null;
    }
  }
  const need = needs(body);
  const able = targets.filter((t) => ![...lacksFor(t.id)].some((c) => need[c]));
  if (able.length) targets = able;

  for (;;) {
    const now = Date.now();
    const pairs = targets.filter((t) => !permanent.has(t.id))
      .flatMap((t) => keysFor(t, endpoint).map((k) => ({ t, k })));
    for (const p of pairs) overBudget(p.t, p.k);
    const size = estimateTokens(body);
    // A cooling pair that frees up before the deadline is waited for. One that stays cool past
    // it is tried anyway as a last resort, unless its delay is certain (stated by the provider,
    // over its known quota, dead key): that call could only fail and burn quota.
    const coolUntil = (p) => h(p.k.hid).until;
    const ready = pairs.filter((p) => coolUntil(p) <= now || (coolUntil(p) > deadline && !h(p.k.hid).hard));
    ready.sort((a, b) => (coolUntil(a) > now) - (coolUntil(b) > now));
    const deadTargets = new Set();

    const tried = new Set();
    // Secondary failures from a hedged call are recorded like any other, without answering the client.
    const note = (t, k, e) => {
      const status = e instanceof Upstream ? normalise(e.status, String(e.message)) : 0;
      if (clientAbort.signal.aborted || String(e.message) === 'client aborted') return;
      errors.push(`${t.id}: ${status || 'ERR'} ${String(e.message).slice(0, 160)}`);
      cooldown(k.hid, status, e.retryAfter);
      if (e.rpm) h(k.hid).learnedRpm = e.rpm;
      const cap = sizeLimit(status, String(e.message));
      if (cap) { Object.assign(h(k.hid), { maxTokens: cap, until: 0, fails: 0, hard: false }); permanent.add(t.id); return; }
      const miss = capabilityMiss(status, String(e.message), need);
      if (miss) { lacksFor(t.id).add(miss); permanent.add(t.id); }
      else if (status === 400 && GENERATION_FAILED.test(String(e.message))) { h(k.hid).until = 0; deadTargets.add(t.id); }
      else if (status === 404 || status === 400 || status === 413) permanent.add(t.id);
      else if (!keyLevel({ status })) deadTargets.add(t.id);
    };
    for (let i = 0; i < ready.length; i++) {
      let { t, k } = ready[i];
      if (deadTargets.has(t.id) || permanent.has(t.id) || tried.has(k.hid)) continue;
      if (h(k.hid).maxTokens && size > h(k.hid).maxTokens) { errors.push(`${t.id}: skipped, request ~${size} tokens > its limit ${h(k.hid).maxTokens}`); continue; }
      if (clientAbort.signal.aborted) return null;
      if (tries++) stats.fallbacks++;
      h(k.hid).calls.push(Date.now());
      let up;
      try {
        const next = hedgeMs > 0 && ready.slice(i + 1).find((p) => p.t.id !== t.id && !deadTargets.has(p.t.id)
          && !permanent.has(p.t.id) && !tried.has(p.k.hid));
        if (next) {
          const r = await hedgedCall({ t, k }, next, body, clientAbort.signal, endpoint, hedgeMs);
          tried.add(k.hid); tried.add(next.k.hid);
          for (const o of r.others) note(o.pair.t, o.pair.k, o.error);
          ({ t, k } = r.pair);
          if (r.error) throw r.error;
          up = r.up;
          if (t !== ready[i].t) { tries++; stats.fallbacks++; }
        } else up = await callOnce(t, k, body, clientAbort.signal, endpoint);
        let out = null;
        const head = { 'x-bascule-target': t.id };
        if (body.stream) await pipeStream(up, t, res, head, requested);
        else {
          const raw = await readJson(up.reader);
          out = t.provider.type === 'anthropic' ? fromAnthropic(raw, t.model) : raw;
          const m = out?.choices?.[0]?.message;
          if (endpoint === '/chat/completions' && !m?.content && !m?.tool_calls?.length) throw new Upstream(502, 'empty answer');
          addUsage(out.usage, t);
          if (ck) cacheSet(ck, out);
          send(res, 200, shape(res, out, requested), head);
        }
        success(k.hid, Date.now() - up.t0);
        tally(tries > 1 ? 'rerouted' : 'ok', Date.now() - t0);
        if (Object.hasOwn(cfg.combos || {}, requested)) (served[requested] ??= {})[t.id] = (served[requested][t.id] || 0) + 1;
        log(200, requested, t.id, t0, tries - 1);
        return out;
      } catch (e) {
        if (clientAbort.signal.aborted) return null;
        const status = e instanceof Upstream ? normalise(e.status, String(e.message)) : 0;
        errors.push(`${t.id}: ${status || 'ERR'} ${String(e.message).slice(0, 160)}`);
        cooldown(k.hid, status, e.retryAfter);
        if (e.rpm) h(k.hid).learnedRpm = e.rpm;
        const cap = res.headersSent ? 0 : sizeLimit(status, String(e.message));
        if (cap) { // the key is fine for smaller requests: no cooldown, remember the size, try the next target
          Object.assign(h(k.hid), { maxTokens: cap, until: 0, fails: 0, hard: false });
          permanent.add(t.id);
          continue;
        }
        if (res.headersSent) { // mid-stream: bytes already left, report in-band and stop
          const msg = `upstream ${t.id} failed mid-stream: ${e.message}`;
          res.end(res.anthropic ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } })}\n\n`
            : `data: ${JSON.stringify(err(msg, 'upstream_error'))}\n\n`);
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
        if (status === 400 && GENERATION_FAILED.test(String(e.message))) { h(k.hid).until = 0; h(k.hid).fails = 0; deadTargets.add(t.id); }
        else if (status === 404 || status === 400 || status === 413) permanent.add(t.id);
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
  tally('failed');
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

// Responses are kept in OpenAI form internally (cache included) and shaped per client on the way out.
const shape = (res, out, model) => (res.anthropic ? toAnthropicMessage(out, model) : out);

async function pipeStream(up, t, res, head, model) {
  let gen = t.provider.type === 'anthropic' ? anthropicStream(up.reader, t.model, (u) => addUsage(u, t)) : passthrough(up.reader, (u) => addUsage(u, t));
  if (res.anthropic) gen = toAnthropicStream(gen, model);
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
    coolingForS: s.until > now ? Math.ceil((s.until - now) / 1000) : 0, ...(s.learnedRpm && { learnedRpm: s.learnedRpm }),
    ...(s.maxTokens && { maxTokens: s.maxTokens }) };
  const cannot = Object.fromEntries([...lacks].filter(([, c]) => c.size).map(([id, c]) => [id, [...c]]));
  const combos = Object.fromEntries(Object.entries(cfg.combos || {}).map(([name, c]) =>
    [name, (Array.isArray(c) ? c : c.targets || []).map((t) => parseTarget(t)?.id).filter(Boolean)]));
  return { version: VERSION, uptimeS: Math.round(process.uptime()), providers: Object.keys(providers), cannot,
    cacheSize: cache.size, ...stats, combos, served, targets, now: now,
    cost: { day: spend.day, usd: spend.usd, byTarget: spend.byTarget, budgetUsd: dailyBudget() || null, capped: capped(),
      priced: [...new Set(Object.values(cfg.combos || {}).flatMap((c) => Array.isArray(c) ? c : c.targets || []).map(parseTarget).filter((t) => t && priceOf(t)).map((t) => t.id))] },
    timeline: timeline.filter((b) => b.m > now / 60_000 - 60).map((b) => ({ t: b.m * 60_000, ok: b.ok, rerouted: b.rerouted, failed: b.failed,
      latencyMs: b.n ? Math.round(b.ms / b.n) : null })) };
}

function log(code, model, target, t0, fallbacks) {
  if (LOG) console.log(`${new Date().toISOString()} ${code} ${model} -> ${target} ${Date.now() - t0}ms${fallbacks ? ` (${fallbacks} fallback${fallbacks > 1 ? 's' : ''})` : ''}`);
}

// ---------- http ----------
const err = (message, code) => ({ error: { message, type: code, code } });
const ANTHROPIC_ERROR = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  413: 'request_too_large', 415: 'invalid_request_error', 429: 'rate_limit_error', 503: 'overloaded_error', 529: 'overloaded_error' };
function send(res, code, obj, headers = {}) {
  if (res.headersSent) return res.end();
  // Anthropic-format clients get Anthropic-shaped errors.
  if (res.anthropic && obj?.error) obj = { type: 'error', error: { type: ANTHROPIC_ERROR[code] || 'api_error', message: obj.error.message } };
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
      const headers = authHeaders(p, key);
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

const localBase = () => {
  const host = HOST === '0.0.0.0' ? '127.0.0.1' : HOST === '::' ? '::1' : HOST;
  return `http://${host.includes(':') ? `[${host}]` : host}:${PORT}`;
};

// ---------- discover ----------
// Free models come and go every few weeks. `bascule discover` lists, per provider: configured models
// the provider no longer offers, chat models it offers that the config does not use, and, where the
// listing carries prices (OpenRouter), the models that cost nothing. --apply writes the safe part:
// retired models out, the best free ones in, with a backup of the previous config.
const NOT_CHAT = /embed|whisper|tts|orpheus|playai|audio|speech|transcri|guard|moderat|rerank|image|dall-e|sora|realtime|search|computer-use|safety|lyria|music|video|^openrouter\/(auto|free)$/i;
// Stealth models are free because the prompts are kept to train them: never picked for anyone.
const isFree = (m) => m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 && !/^stealth\//.test(m.id);
// Tool support first (agents need it), then context size, then the newest.
const rank = (a, b) => b.id.endsWith(':free') - a.id.endsWith(':free') || (b.supported_parameters?.includes('tools') ?? false) - (a.supported_parameters?.includes('tools') ?? false)
  || (b.context_length || 0) - (a.context_length || 0) || (b.created || 0) - (a.created || 0);

async function listModelsOf(p, key) {
  const url = p.type === 'anthropic' ? `${p.baseUrl}/v1/models` : `${p.baseUrl}/models`;
  const r = await fetch(url, { headers: key === undefined ? {} : authHeaders(p, key), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()).data;
  if (!Array.isArray(data)) throw new Error('no model list');
  return data.map((m) => ({ ...m, id: String(m.id).replace(/^models\//, '') }));
}

async function discover(apply) {
  const found = {};
  for (const [name, raw] of Object.entries(cfg.providers || {})) {
    const p = providers[name];
    let list;
    try {
      // A provider without a key can still show its public catalogue (OpenRouter does).
      list = await listModelsOf(p || { ...raw, name, type: raw.type || 'openai', headers: raw.headers || {} }, p?.keys[0]);
    } catch (e) {
      console.log(`  -  ${name}: ${p ? `cannot list models (${e.cause?.code || e.message})` : 'no key set, skipped'}`);
      continue;
    }
    const ids = new Set(list.map((m) => m.id));
    const configured = raw.models || [];
    const retired = configured.filter((m) => !ids.has(m));
    // Prices only mean something when the catalogue mixes free and paid models (OpenRouter). Groq or
    // Gemini list prices too, yet their whole catalogue is on the account's free tier.
    const free = list.filter(isFree).filter((m) => !NOT_CHAT.test(m.id)).sort(rank);
    const priced = free.length > 0;
    const fresh = (priced ? free : list.filter((m) => !NOT_CHAT.test(m.id))).filter((m) => !configured.includes(m.id));
    found[name] = { retired, free: free.filter((m) => !configured.includes(m.id)).map((m) => m.id), hasKey: Boolean(p) };
    console.log(`  ${p ? '✓' : '-'}  ${name}: ${list.length} models listed${priced ? `, ${free.length} free` : ''}${p ? '' : ' (no key: public list)'}`);
    for (const m of retired) console.log(`       retired: ${m}  (no longer offered: remove it)`);
    for (const m of fresh.slice(0, 8)) {
      const tags = [isFree(m) && 'free', m.supported_parameters?.includes('tools') && 'tools', m.context_length && `${Math.round(m.context_length / 1000)}k context`].filter(Boolean);
      console.log(`       new:     ${m.id}${tags.length ? `  (${tags.join(', ')})` : ''}`);
    }
    if (fresh.length > 8) console.log(`       ... and ${fresh.length - 8} more`);
    if (!p && free.length) console.log(`       a free ${name} key unlocks these: put it in ${ENV_PATH || '.env'}`);
  }
  const retiredCount = Object.values(found).reduce((a, f) => a + f.retired.length, 0);
  let toAdd = Object.entries(found).filter(([, f]) => f.hasKey && f.free.length);
  // Being listed is no proof of access: only models that answer a tiny request are added, 3 per provider.
  if (apply) {
    for (const [n, f] of toAdd) {
      const ok = [];
      for (const m of f.free) {
        if (ok.length === 3) break;
        try {
          const up = await callOnce({ provider: providers[n], model: m, id: `${n}/${m}` }, { key: providers[n].keys[0] },
            { messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }, AbortSignal.timeout(30_000), '/chat/completions');
          await readJson(up.reader); up.cleanup();
          ok.push(m);
          console.log(`  ✓  ${n}/${m} answers`);
        } catch (e) {
          // A 429 is about the account (daily free quota), not the model: testing more only burns tries.
          if (e.status === 429) { console.log(`  -  ${n}: free quota used up for now (429), try again later`); break; }
          console.log(`  ✗  ${n}/${m} skipped: ${e.status || ''} ${String(e.message).replace(/\s+/g, ' ').slice(0, 80)}`);
        }
      }
      f.free = ok;
    }
    toAdd = toAdd.filter(([, f]) => f.free.length);
  } else for (const [, f] of toAdd) f.free = f.free.slice(0, 3);
  if (!retiredCount && !toAdd.length) { console.log('\n  nothing to change automatically'); return true; }
  if (!apply) {
    console.log(`\n  run "bascule discover --apply" to remove ${retiredCount} retired model${retiredCount === 1 ? '' : 's'}`
      + `${toAdd.length ? ` and add ${toAdd.map(([n, f]) => `${f.free.length} free ${n} model${f.free.length === 1 ? '' : 's'}`).join(', ')} to the "auto" combo` : ''}`);
    return true;
  }
  // Edit the file as written, with its ${VARIABLES} intact, not the expanded config in memory.
  const text = readFileSync(CONFIG_PATH, 'utf8');
  const file = JSON.parse(text);
  const drop = new Set(Object.entries(found).flatMap(([n, f]) => f.retired.map((m) => `${n}/${m}`)));
  for (const [n, f] of Object.entries(found)) {
    file.providers[n].models = file.providers[n].models.filter((m) => !f.retired.includes(m));
  }
  for (const [name, c] of Object.entries(file.combos || {})) {
    const keep = (list) => list.filter((t) => !drop.has(t));
    if (Array.isArray(c)) file.combos[name] = keep(c); else c.targets = keep(c.targets || []);
  }
  const auto = file.combos?.auto;
  const autoList = Array.isArray(auto) ? auto : auto?.targets;
  for (const [n, f] of toAdd) {
    for (const m of f.free) {
      file.providers[n].models.push(m);
      // Free cloud models go before the keyless local fallback (Ollama), which stays last.
      if (autoList && !autoList.includes(`${n}/${m}`)) {
        const local = autoList.findIndex((t) => file.providers[t.split('/')[0]]?.requiresKey === false);
        autoList.splice(local < 0 ? autoList.length : local, 0, `${n}/${m}`);
      }
    }
  }
  writeFileSync(CONFIG_PATH + '.bak', text);
  writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  console.log(`\n  updated ${CONFIG_PATH} (previous version in ${CONFIG_PATH}.bak)`);
  if (CONFIG_PATH === join(ROOT, 'config.json') && !localSetup) console.log('  note: this is the bundled config, replaced on update. Run "bascule init" to get your own in ~/.bascule');
  console.log('  a running bascule reloads it by itself');
  return true;
}

async function printStatus() {
  const url = `${localBase()}/stats`;
  let st;
  try {
    const r = await fetch(url, { headers: API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    st = await r.json();
  } catch (e) { console.error(`no router answering on ${url} (${e.cause?.code || e.message}). Start it with: bascule`); return false; }
  console.log(`bascule ${st.version}, up ${st.uptimeS}s, providers: ${st.providers.join(', ')}`);
  console.log(`requests ${st.requests}  cache hits ${st.cacheHits}  fallbacks ${st.fallbacks}  failures ${st.failures}  tokens ${st.tokens.prompt} in / ${st.tokens.completion} out`);
  console.log(`spent today $${st.cost.usd.toFixed(4)}${st.cost.budgetUsd ? ` of $${st.cost.budgetUsd}${st.cost.capped ? '  (budget reached: free targets only)' : ''}` : ''}`);
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

const ENDPOINTS = { '/v1/chat/completions': '/chat/completions', '/v1/embeddings': '/embeddings',
  '/v1/messages': 'anthropic', '/v1/messages/count_tokens': 'count_tokens' };

if (arg === 'doctor') process.exit((await doctor(process.argv.includes('--deep'))) ? 0 : 1);
if (arg === 'status') process.exit((await printStatus()) ? 0 : 1);
if (arg === 'discover') process.exit((await discover(process.argv.includes('--apply'))) ? 0 : 1);
// The key rides in the URL fragment, which browsers never send to the server; the page moves it
// to localStorage and wipes it from the address bar.
if (arg === 'dashboard') {
  try { await fetch(`${localBase()}/health`, { signal: AbortSignal.timeout(5000) }); }
  catch (e) { console.error(`no router answering on ${localBase()} (${e.cause?.code || e.message}). Start it with: bascule`); process.exit(1); }
  const url = `${localBase()}/${API_KEY ? `#key=${encodeURIComponent(API_KEY)}` : ''}`;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  console.log(`dashboard: ${localBase()}/`);
  process.exit(0);
}

// ---------- dashboard ----------
// One self-contained page, no external assets. The strict CSP pins the inline style and script by hash.
// Each combo is drawn as a transit line: a request leaves the first station and stops at the first
// open one. Every answer seen since the last refresh runs along its line as a small train.
const DASHBOARD_CSS = `
:root { color-scheme: light dark;
  --paper: #f3f4f6; --panel: #ffffff; --ink: #0f1c2e; --soft: #5a6a7e; --faint: #8795a8; --rule: #dde2e9;
  --go: #16874a; --wait: #c77c02; --stop: #cc3a32; --idle: #b3bcc8;
  --s-ok: #2455d8; --s-rerouted: #c77c02; --s-failed: #b42318;
  --sans: "Helvetica Neue", Helvetica, "Arial Nova", Arial, system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) {
  :root { --paper: #0c1522; --panel: #131f30; --ink: #eaf0f7; --soft: #a0b0c4; --faint: #71839b; --rule: #243349;
    --go: #34b86d; --wait: #e6a23c; --stop: #ef5a50; --idle: #4d5d74;
    --s-ok: #5b8def; --s-rerouted: #a88f10; --s-failed: #c93a52; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
main { max-width: 1080px; margin: 0 auto; padding: 0 28px 72px; }
:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; border-radius: 4px; }
button { font: inherit; cursor: pointer; }

.top { display: flex; align-items: center; gap: 12px; padding: 22px 0; border-bottom: 1px solid var(--rule); margin-bottom: 56px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 19px; letter-spacing: -.01em; }
.brand svg { width: 28px; height: 28px; }
.meta { margin-left: auto; color: var(--soft); font-size: 14px; display: flex; align-items: center; gap: 8px; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--go); }
.pulse.down { background: var(--stop); }

.hero { display: grid; grid-template-columns: auto 1fr; column-gap: 22px; align-items: start; margin-bottom: 44px; }
.signal { width: 22px; height: 22px; border-radius: 50%; margin-top: .32em; background: var(--go);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--go) 18%, transparent); }
.signal.warn { background: var(--wait); box-shadow: 0 0 0 6px color-mix(in srgb, var(--wait) 20%, transparent); }
.signal.bad { background: var(--stop); box-shadow: 0 0 0 6px color-mix(in srgb, var(--stop) 20%, transparent); }
.signal.idle { background: var(--idle); box-shadow: 0 0 0 6px color-mix(in srgb, var(--idle) 25%, transparent); }
.hero h1 { font-size: clamp(30px, 5vw, 52px); line-height: 1.06; letter-spacing: -.03em; font-weight: 700; margin: 0 0 12px; max-width: 22ch; }
.hero p { grid-column: 2; font-size: clamp(16px, 1.8vw, 19px); color: var(--soft); margin: 0; max-width: 62ch; }
.hero p strong { color: var(--ink); font-weight: 600; }
.code { font-family: var(--mono); font-size: .86em; background: var(--panel); border: 1px solid var(--rule); padding: 1px 6px; border-radius: 5px; color: var(--ink); white-space: nowrap; }

.numbers { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin: 0 0 16px; background: var(--panel);
  border: 1px solid var(--rule); border-radius: 14px; }
.numbers > div { padding: 18px 22px; }
.numbers > div + div { border-left: 1px solid var(--rule); }
.numbers b { display: block; font-size: 32px; line-height: 1.1; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.numbers span { color: var(--soft); font-size: 14px; }
.numbers .bad b { color: var(--stop); }
.meter { height: 6px; border-radius: 3px; background: var(--rule); margin-top: 8px; overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--s-ok); border-radius: 3px; }
.meter.full i { background: var(--stop); }
.numbers small { display: block; color: var(--faint); font-size: 12px; margin-top: 4px; }

.traffic { background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; padding: 22px 26px 18px; margin: 0 0 64px; }
.traffic header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px 24px; flex-wrap: wrap; margin-bottom: 18px; }
.traffic h2 { font-size: 18px; margin: 0; }
.traffic header p { margin: 0; color: var(--soft); font-size: 14px; }
.keys { display: flex; flex-wrap: wrap; gap: 4px 18px; list-style: none; margin: 0; padding: 0; font-size: 13px; color: var(--soft); }
.keys i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.k-ok i { background: var(--s-ok); } .k-rerouted i { background: var(--s-rerouted); } .k-failed i { background: var(--s-failed); }
.plot { position: relative; height: 150px; margin-left: 34px; border-bottom: 1px solid var(--soft); }
.grid-y { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--rule); }
.grid-y span { position: absolute; right: calc(100% + 8px); top: -9px; font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
.bars { position: absolute; inset: 0; display: flex; align-items: flex-end; gap: 2px; }
.bar { flex: 1 1 0; height: 100%; display: flex; flex-direction: column-reverse; gap: 2px; position: relative; }
.bar i { display: block; min-height: 2px; }
.bar i:last-child { border-radius: 3px 3px 0 0; }
.bar .ok { background: var(--s-ok); } .bar .rerouted { background: var(--s-rerouted); } .bar .failed { background: var(--s-failed); }
.bar:hover, .bar:focus-visible { background: color-mix(in srgb, var(--ink) 6%, transparent); outline: 0; }
.axis-x { display: flex; justify-content: space-between; margin: 6px 0 0 34px; font-size: 12px; color: var(--faint); }
.tip { position: absolute; bottom: calc(100% + 8px); background: var(--ink); color: var(--paper); font-size: 13px; line-height: 1.45; padding: 8px 11px;
  border-radius: 8px; white-space: nowrap; pointer-events: none; z-index: 3; transform: translateX(-50%); }
.tip b { display: block; }
.tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; }
.section-head { display: flex; align-items: end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
h2 { font-size: 24px; letter-spacing: -.02em; margin: 0 0 4px; }
.lead { color: var(--soft); margin: 0; max-width: 62ch; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--soft); font-size: 13px; padding: 0; margin: 0; list-style: none; }
.legend i { display: inline-block; width: 11px; height: 11px; border-radius: 50%; border: 3px solid var(--idle); background: var(--panel); margin-right: 6px; vertical-align: -1px; }
.legend .go i { border-color: var(--go); } .legend .wait i { border-color: var(--wait); } .legend .stopped i { border-color: var(--stop); background: var(--stop); }

.line { --c: #2455d8; background: var(--panel); border: 1px solid var(--rule); border-radius: 14px; padding: 20px 26px 22px; margin-bottom: 12px; }
.line.blocked { border-color: var(--stop); }
.line header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
.badge { background: var(--c); color: #fff; font-weight: 700; font-size: 15px; letter-spacing: .01em; padding: 4px 12px; border-radius: 8px; }
.line header .info { color: var(--soft); font-size: 14px; }
.line header .info b { color: var(--ink); font-weight: 600; }
.line header .count { margin-left: auto; color: var(--soft); font-size: 14px; font-variant-numeric: tabular-nums; }
.stops { list-style: none; margin: 0; padding: 0; display: flex; position: relative; }
.stop { position: relative; flex: 1 1 0; min-width: 0; padding: 36px 12px 0 0; }
.stop::before { content: ""; position: absolute; top: 13px; left: 0; right: 0; height: 6px; background: var(--c); }
.stop:first-child::before { left: 13px; }
.stop:last-child::before { right: calc(100% - 13px); }
.stop:only-child::before { display: none; }
.dot { position: absolute; top: 3px; left: 3px; width: 26px; height: 26px; border-radius: 50%; background: var(--panel); border: 6px solid var(--idle); z-index: 1; }
.go .dot { border-color: var(--go); } .wait .dot { border-color: var(--wait); } .stopped .dot { border-color: var(--stop); background: var(--stop); }
.head .dot { border-color: var(--go); background: var(--go); }
.arrive .dot { animation: arrive .7s ease-out; }
@keyframes arrive { from { box-shadow: 0 0 0 0 color-mix(in srgb, var(--go) 60%, transparent); } to { box-shadow: 0 0 0 14px transparent; } }
.who { display: block; font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.what { display: block; font-weight: 600; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.how { display: block; font-size: 13px; margin-top: 2px; color: var(--faint); font-variant-numeric: tabular-nums; }
.go .how { color: var(--go); } .wait .how { color: var(--wait); } .stopped .how { color: var(--stop); }
.train { position: absolute; top: 9px; left: 3px; width: 26px; height: 14px; border-radius: 7px; background: var(--c); border: 2px solid var(--panel);
  z-index: 2; pointer-events: none; }

.connect { margin-top: 48px; display: grid; grid-template-columns: 1fr auto; gap: 18px 24px; align-items: center; background: var(--ink); color: var(--paper);
  border-radius: 14px; padding: 24px 26px; }
.connect h3 { margin: 0 0 4px; font-size: 18px; }
.connect p { margin: 0; color: color-mix(in srgb, var(--paper) 72%, transparent); font-size: 15px; }
.connect .code { background: transparent; color: var(--paper); border-color: color-mix(in srgb, var(--paper) 30%, transparent); }
.connect button { background: var(--paper); color: var(--ink); border: 0; border-radius: 9px; padding: 11px 18px; font-weight: 700; }

details { margin-top: 40px; border-top: 1px solid var(--rule); padding-top: 18px; }
summary { cursor: pointer; font-weight: 700; font-size: 16px; width: fit-content; }
.tablewrap { overflow-x: auto; margin-top: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 9px 16px 9px 0; border-bottom: 1px solid var(--rule); white-space: nowrap; }
th { color: var(--soft); font-weight: 600; }
td:first-child { font-family: var(--mono); font-size: 13px; }
.num { text-align: right; }

.gate { max-width: 540px; }
.gate h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.08; letter-spacing: -.03em; margin: 0 0 12px; }
.gate p { color: var(--soft); margin: 0; }
.gate form { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 26px; }
.gate input { flex: 1 1 240px; font: inherit; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--rule); background: var(--panel); color: var(--ink); }
.gate button { font-weight: 700; padding: 12px 22px; border: 0; border-radius: 10px; background: var(--ink); color: var(--paper); }
.gate .msg { color: var(--stop); width: 100%; margin: 0; min-height: 1.5em; }

@media (max-width: 700px) {
  main { padding: 0 16px 48px; }
  .top { margin-bottom: 36px; }
  .hero { column-gap: 14px; }
  .signal { width: 16px; height: 16px; }
  .numbers { grid-template-columns: 1fr 1fr; }
  .numbers > div + div { border-left: 0; }
  .numbers > div:nth-child(even) { border-left: 1px solid var(--rule); }
  .numbers > div:nth-child(n+3) { border-top: 1px solid var(--rule); }
  .line { padding: 18px 18px 8px; }
  .traffic { padding: 18px 16px 14px; }
  .bars { gap: 1px; }
  .line header .count { margin-left: 0; width: 100%; }
  .stops { flex-direction: column; }
  .stop { flex: none; padding: 0 0 18px 44px; min-height: 48px; }
  .stop::before { top: 0; bottom: 0; left: 13px; right: auto; width: 6px; height: auto; }
  .stop:first-child::before { top: 13px; left: 13px; }
  .stop:last-child::before { right: auto; bottom: calc(100% - 16px); }
  .train { top: 3px; left: 9px; width: 14px; height: 26px; }
  .connect { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) { .train { display: none; } .arrive .dot { animation: none; } }
[hidden] { display: none !important; }
`;
const DASHBOARD_JS = `
const T = {
  en: {
    live: 'Live', offline: 'Not answering', up: 'up ',
    good: 'Good service on all lines.', delays: 'Minor delays.', idleTitle: 'Ready for the first request.',
    suspended: (n) => 'Service suspended on ' + n + '.', down: 'Bascule is not answering.',
    idleText: 'Nothing has gone through yet. Connect an application with the address below and the lines will light up.',
    summary: (up, ok, fb) => 'In the last ' + up + ', <strong>' + ok + (ok === '1' ? ' request' : ' requests') + ' answered</strong>' + (fb !== '0' ? ', of which <strong>' + fb + '</strong> reached their answer by switching model.' : '.'),
    detourText: (n) => ' ' + n + (n > 1 ? ' stations are' : ' station is') + ' paused, so requests are rerouted to the next open one.',
    blockedText: ' Every station on this line is paused or down, so its requests fail until one reopens.',
    downText: 'Start it again with the command <span class="code">bascule</span>. This page reconnects on its own.',
    availability: 'Availability', answered: 'Requests answered', switched: 'Rerouted', failed: 'Failed', speed: 'Average response time', tokens: 'Tokens processed', cached: 'Answered from cache',
    spent: 'Spent today', of: (b) => 'Budget ' + b + ' a day', free: 'Free models only', capTitle: 'Daily budget reached.',
    capText: (b) => 'Today’s spend has reached ' + b + '. Until midnight, requests go to free models only; paid stations are closed.', capped: 'Closed: budget reached', cost: 'Cost today',
    trafficTitle: 'Traffic, last hour', trafficLead: 'Requests per minute.', ago: (m) => m + ' min ago', nowLabel: 'now',
    sOk: 'Answered directly', sRerouted: 'Answered after reroute', sFailed: 'Failed', tipMin: (t) => t, avgMs: (ms) => ms + ' ms on average',
    linesTitle: 'Lines', linesLead: 'A request stops at the first open station. If it is busy or down, the request continues to the next one.',
    now: 'Now serving', blockedLine: 'No open station', served: (n) => n + ' answered',
    go: 'Open', wait: (s) => 'Back in ' + s, stopped: 'Down', idle: 'Not used yet',
    lgo: 'Open', lwait: 'Paused, reopens on its own', lstopped: 'Down, check the key', lidle: 'Not used yet',
    connectTitle: 'Connect an application', connectText: (u) => 'Use <span class="code">' + u + '</span> as the OpenAI-compatible address, your access key as the API key, and <span class="code">auto</span> as the model.',
    copy: 'Copy address', copied: 'Address copied',
    details: 'Technical details', model: 'Model and key', state: 'State', ok: 'Answered', err: 'Errors', latency: 'Response time', limit: 'Limit', cannot: 'Cannot handle',
    perMin: '/min', vision: 'images', tools: 'tools',
    gateTitle: 'This dashboard is locked.', gateText: 'Paste your access key: the BASCULE_KEY line in ~/.bascule/.env. The command bascule dashboard opens it already unlocked.',
    open: 'Unlock', badKey: 'This key does not match BASCULE_KEY.', placeholder: 'Access key' },
  fr: {
    live: 'En direct', offline: 'Ne répond pas', up: 'actif depuis ',
    good: 'Trafic normal sur toutes les lignes.', delays: 'Trafic perturbé.', idleTitle: 'Prêt pour la première demande.',
    suspended: (n) => 'Trafic interrompu sur ' + n + '.', down: 'Bascule ne répond pas.',
    idleText: 'Aucune demande pour l’instant. Branchez une application avec l’adresse ci-dessous et les lignes s’allumeront.',
    summary: (up, ok, fb) => 'Depuis ' + up + ', <strong>' + ok + (ok === '1' ? ' demande servie' : ' demandes servies') + '</strong>' + (fb !== '0' ? ', dont <strong>' + fb + '</strong> arrivées à destination grâce à un changement de modèle.' : '.'),
    detourText: (n) => ' ' + n + (n > 1 ? ' stations sont en pause' : ' station est en pause') + ' : les demandes sont déviées vers la suivante ouverte.',
    blockedText: ' Toutes les stations de cette ligne sont en pause ou en panne : ses demandes échouent jusqu’à la réouverture de l’une d’elles.',
    downText: 'Relancez-le avec la commande <span class="code">bascule</span>. Cette page se reconnecte d’elle-même.',
    availability: 'Disponibilité', answered: 'Demandes servies', switched: 'Déviées', failed: 'Échecs', speed: 'Temps de réponse moyen', tokens: 'Tokens traités', cached: 'Servies depuis le cache',
    spent: 'Dépensé aujourd’hui', of: (b) => 'Budget ' + b + ' par jour', free: 'Modèles gratuits uniquement', capTitle: 'Budget du jour atteint.',
    capText: (b) => 'La dépense du jour a atteint ' + b + '. Jusqu’à minuit, les demandes vont uniquement vers les modèles gratuits ; les stations payantes sont fermées.', capped: 'Fermée : budget atteint', cost: 'Coût du jour',
    trafficTitle: 'Trafic de la dernière heure', trafficLead: 'Demandes par minute.', ago: (m) => 'il y a ' + m + ' min', nowLabel: 'maintenant',
    sOk: 'Servies directement', sRerouted: 'Servies après déviation', sFailed: 'Échouées', tipMin: (t) => t, avgMs: (ms) => ms + ' ms en moyenne',
    linesTitle: 'Lignes', linesLead: 'Une demande s’arrête à la première station ouverte. Si elle est occupée ou en panne, la demande continue vers la suivante.',
    now: 'Dessert', blockedLine: 'Aucune station ouverte', served: (n) => n + (n === '1' ? ' servie' : ' servies'),
    go: 'Ouverte', wait: (s) => 'Retour dans ' + s, stopped: 'En panne', idle: 'Pas encore utilisée',
    lgo: 'Ouverte', lwait: 'En pause, rouvre d’elle-même', lstopped: 'En panne, vérifier la clé', lidle: 'Pas encore utilisée',
    connectTitle: 'Brancher une application', connectText: (u) => 'Adresse compatible OpenAI <span class="code">' + u + '</span>, votre clé d’accès comme clé API, et le modèle <span class="code">auto</span>.',
    copy: 'Copier l’adresse', copied: 'Adresse copiée',
    details: 'Détails techniques', model: 'Modèle et clé', state: 'État', ok: 'Servies', err: 'Erreurs', latency: 'Temps de réponse', limit: 'Limite', cannot: 'Ne gère pas',
    perMin: '/min', vision: 'images', tools: 'outils',
    gateTitle: 'Ce tableau de bord est verrouillé.', gateText: 'Saisissez votre clé d’accès : la ligne BASCULE_KEY du fichier ~/.bascule/.env. La commande bascule dashboard l’ouvre directement déverrouillé.',
    open: 'Déverrouiller', badKey: 'Cette clé ne correspond pas à BASCULE_KEY.', placeholder: 'Clé d’accès' },
};
const lang = (navigator.language || 'en').slice(0, 2);
const L = T[lang] || T.en;
document.documentElement.lang = T[lang] ? lang : 'en';
const $ = (id) => document.getElementById(id);
const el = (tag, cls, ...kids) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids.map((k) => k instanceof Node ? k : String(k))); return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (n) => Math.round(Number(n || 0)).toLocaleString(lang);
const dur = (s) => s >= 86400 ? Math.floor(s / 86400) + (lang === 'fr' ? ' j ' : ' d ') + Math.floor(s % 86400 / 3600) + ' h'
  : s >= 3600 ? Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min' : s >= 60 ? Math.floor(s / 60) + ' min' : s + ' s';
const endpoint = location.origin + '/v1';
const usd = (v) => new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.01 ? 4 : 2 }).format(v);
const still = matchMedia('(prefers-reduced-motion: reduce)');
const LINE_COLORS = ['#2455d8', '#7a3fc4', '#0b7f8a', '#b8406f', '#8a5a1f', '#3b5b86'];

let key = localStorage.getItem('bascule-key') || '';
function keyFromHash() {
  const k = new URLSearchParams(location.hash.slice(1)).get('key');
  if (k) { key = k; localStorage.setItem('bascule-key', k); history.replaceState(null, '', location.pathname); }
}
keyFromHash();
addEventListener('hashchange', () => { keyFromHash(); poll(); });

$('gate-title').textContent = L.gateTitle; $('gate-text').textContent = L.gateText; $('open').textContent = L.open;
$('keyinput').placeholder = L.placeholder;
$('keyform').addEventListener('submit', (e) => { e.preventDefault(); key = $('keyinput').value.trim(); localStorage.setItem('bascule-key', key); $('keyinput').value = ''; poll(); });
$('lines-title').textContent = L.linesTitle; $('lines-lead').textContent = L.linesLead; $('details-title').textContent = L.details;
$('legend').replaceChildren(...[['go', L.lgo], ['wait', L.lwait], ['stopped', L.lstopped], ['idle', L.lidle]].map(([c, t]) => el('li', c, el('i'), t)));
$('connect-title').textContent = L.connectTitle; $('connect-text').innerHTML = L.connectText(esc(endpoint)); $('copy').textContent = L.copy;
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(endpoint); $('copy').textContent = L.copied; setTimeout(() => { $('copy').textContent = L.copy; }, 1800); } catch {}
});

function stateOf(t) {
  if (!t) return 'idle';
  if (t.coolingForS) return 'wait';
  if (!t.ok && !t.err) return 'idle';
  return t.ok ? 'go' : 'stopped';
}
// Several keys per model: the station is open while one key is.
function station(st, id) {
  if (st.cost?.capped && st.cost.priced.includes(id)) return { s: 'wait', capped: true };
  const ks = Object.entries(st.targets).filter(([hid]) => hid.startsWith(id + '#')).map(([, t]) => t);
  if (!ks.length) return { s: 'idle' };
  for (const s of ['go', 'idle']) { const t = ks.find((k) => stateOf(k) === s); if (t) return { s, t }; }
  const t = ks.filter((k) => k.coolingForS).sort((a, b) => a.coolingForS - b.coolingForS)[0];
  return t ? { s: 'wait', t } : { s: 'stopped', t: ks[0] };
}
const say = (s, t, capped) => capped ? L.capped : s === 'wait' ? L.wait(dur(t.coolingForS)) : L[s];
const split = (id) => { const i = id.indexOf('/'); return [id.slice(0, i), id.slice(i + 1)]; };

// Numbers glide to their new value instead of jumping.
function count(node, to) {
  const from = Number(node.dataset.v || 0);
  node.dataset.v = to;
  if (still.matches || from === to || !node.isConnected) { node.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 600), e = 1 - (1 - k) ** 3;
    node.textContent = fmt(from + (to - from) * e);
    if (k < 1 && node.dataset.v == to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Lines are built once per shape and then updated in place, so running trains are not cut.
let shape = '', built = {}, lastServed = null;
function buildLines(st) {
  built = {};
  $('lines').replaceChildren(...Object.entries(st.combos || {}).map(([name, ids], i) => {
    const info = el('span', 'info'), cnt = el('span', 'count');
    const stops = ids.map((id) => {
      const [who, what] = split(id), how = el('span', 'how');
      const li = el('li', 'stop', el('span', 'dot'), el('span', 'who', who), el('span', 'what', what), how);
      li.title = id;
      return { id, li, how };
    });
    const ol = el('ol', 'stops', ...stops.map((x) => x.li));
    const sec = el('section', 'line', el('header', '', el('span', 'badge', name), info, cnt), ol);
    sec.style.setProperty('--c', LINE_COLORS[i % LINE_COLORS.length]);
    built[name] = { sec, info, cnt, ol, stops };
    return sec;
  }));
}
function train(line, stop) {
  stop.li.classList.remove('arrive');
  if (still.matches) return;
  const box = line.ol.getBoundingClientRect(), a = line.stops[0].li.querySelector('.dot').getBoundingClientRect(), b = stop.li.querySelector('.dot').getBoundingClientRect();
  const dx = b.left - a.left, dy = b.top - a.top;
  const car = el('span', 'train');
  line.ol.append(car);
  const ms = 450 + Math.hypot(dx, dy) * 0.9;
  car.animate([{ transform: 'translate(0,0)', opacity: 0 }, { opacity: 1, offset: 0.08 }, { transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: 1, offset: 0.92 },
    { transform: 'translate(' + dx + 'px,' + dy + 'px)', opacity: 0 }], { duration: ms, easing: 'cubic-bezier(.45,0,.25,1)' })
    .finished.then(() => { car.remove(); void stop.li.offsetWidth; stop.li.classList.add('arrive'); }, () => car.remove());
}

function render(st) {
  $('meta').replaceChildren(el('span', 'pulse'), L.live + ' · ' + L.up + dur(st.uptimeS) + ' · v' + st.version);
  const sig = JSON.stringify(st.combos || {});
  if (sig !== shape) { shape = sig; buildLines(st); }

  let paused = new Set(), blocked = [];
  for (const [name, line] of Object.entries(built)) {
    let head = null;
    for (const x of line.stops) {
      const { s, t, capped } = station(st, x.id);
      if (!head && (s === 'go' || s === 'idle')) head = x;
      if (s === 'wait' || s === 'stopped') paused.add(x.id);
      x.li.classList.remove('go', 'wait', 'stopped', 'idle', 'head');
      x.li.classList.add(s);
      x.how.textContent = say(s, t, capped);
    }
    if (head && station(st, head.id).s === 'go') head.li.classList.add('head');
    line.sec.classList.toggle('blocked', !head && line.stops.length > 0);
    if (!head && line.stops.length) blocked.push(name);
    const [who, what] = head ? split(head.id) : [];
    line.info.replaceChildren(...(head ? [L.now + ' ', el('b', '', what), ' · ' + who] : [L.blockedLine]));
    const n = Object.values(st.served?.[name] || {}).reduce((a, b) => a + b, 0);
    line.cnt.textContent = n ? L.served(fmt(n)) : '';
    // A few trains at most per refresh, spaced out, for the answers since the last one.
    if (lastServed) {
      let delay = 0;
      for (const x of line.stops) {
        const fresh = Math.min(3, (st.served?.[name]?.[x.id] || 0) - (lastServed[name]?.[x.id] || 0));
        for (let k = 0; k < fresh; k++, delay += 380) setTimeout(() => train(line, x), delay);
      }
    }
  }
  lastServed = JSON.parse(JSON.stringify(st.served || {}));

  const answered = st.requests - st.failures, sum = L.summary(dur(st.uptimeS), fmt(answered), fmt(st.fallbacks));
  let title, text, level;
  if (st.cost?.capped && !blocked.length) { level = 'warn'; title = L.capTitle; text = L.capText(usd(st.cost.budgetUsd)); }
  else if (blocked.length) { level = 'bad'; title = L.suspended(blocked.join(', ')); text = (st.requests ? sum : '') + L.blockedText; }
  else if (!st.requests) { level = 'idle'; title = L.idleTitle; text = L.idleText; }
  else if (paused.size) { level = 'warn'; title = L.delays; text = sum + L.detourText(paused.size); }
  else { level = 'ok'; title = L.good; text = sum; }
  $('signal').className = 'signal ' + level;
  $('title').textContent = title; $('text').innerHTML = text;

  const tl = st.timeline || [], timed = tl.filter((b) => b.latencyMs !== null);
  const w = timed.reduce((a, b) => a + b.ok + b.rerouted, 0);
  const avg = w ? Math.round(timed.reduce((a, b) => a + b.latencyMs * (b.ok + b.rerouted), 0) / w) : null;
  const nums = [['availability', st.requests ? answered / st.requests * 100 : null, (v) => v === null ? '–' : (v >= 99.95 ? '100' : v.toLocaleString(lang, { maximumFractionDigits: 1 })) + ' %'],
    ['answered', answered], ['switched', st.fallbacks], ['failed', st.failures],
    ['speed', avg, (v) => v === null ? '–' : v < 1000 ? fmt(v) + ' ms' : (v / 1000).toLocaleString(lang, { maximumFractionDigits: 1 }) + ' s'],
    ['spent', st.cost?.usd || 0, usd], ...(st.cacheHits ? [['cached', st.cacheHits]] : [])];
  if ($('numbers').dataset.shape !== nums.map((n) => n[0]).join()) {
    $('numbers').dataset.shape = nums.map((n) => n[0]).join();
    $('numbers').replaceChildren(...nums.map(([k]) => { const d = el('div', '', el('b'), el('span', '', L[k])); d.id = 'n-' + k; return d; }));
  }
  for (const [k, v, f] of nums) {
    const d = $('n-' + k);
    d.classList.toggle('bad', (k === 'failed' && v > 0) || (k === 'availability' && v !== null && v < 95));
    if (f) d.firstChild.textContent = f(v); else count(d.firstChild, Math.round(v));
  }
  const sp = $('n-spent'), b = st.cost?.budgetUsd;
  sp.classList.toggle('bad', !!st.cost?.capped);
  let meter = sp.querySelector('.meter');
  if (b && !meter) { meter = el('div', 'meter', el('i')); sp.append(meter, el('small', 'budget')); }
  if (!b && meter) { meter.remove(); sp.querySelector('.budget').remove(); }
  if (b) sp.querySelector('.budget').textContent = L.of(usd(b));
  if (b) { meter.firstChild.style.width = Math.min(100, st.cost.usd / b * 100) + '%'; meter.classList.toggle('full', !!st.cost.capped); }
  chart(tl, st.now);

  const rows = Object.entries(st.targets).sort(([a], [b]) => a.localeCompare(b));
  $('details').hidden = !rows.length;
  $('thead').replaceChildren(el('tr', '', el('th', '', L.model), el('th', '', L.state), el('th', 'num', L.ok), el('th', 'num', L.err),
    el('th', 'num', L.latency), el('th', 'num', L.cost), el('th', 'num', L.limit), el('th', '', L.cannot)));
  $('tbody').replaceChildren(...rows.map(([hid, t]) => {
    const s = stateOf(t), base = hid.replace(/^[a-z]+:/, '').replace(/#[0-9]+$/, '');
    const closed = st.cost?.capped && st.cost.priced.includes(base);
    return el('tr', '', el('td', '', hid), el('td', '', say(closed ? 'wait' : s, t, closed)), el('td', 'num', fmt(t.ok)), el('td', 'num', fmt(t.err)),
      el('td', 'num', t.ok ? t.latencyMs + ' ms' : '–'), el('td', 'num', st.cost?.byTarget[base] ? usd(st.cost.byTarget[base]) : '–'), el('td', 'num', t.learnedRpm ? t.learnedRpm + L.perMin : ''),
      el('td', '', (st.cannot[base] || []).map((c) => L[c] || c).join(', ')));
  }));
}

const SERIES = [['ok', 'sOk'], ['rerouted', 'sRerouted'], ['failed', 'sFailed']];
$('traffic-title').textContent = L.trafficTitle; $('traffic-lead').textContent = L.trafficLead;
$('keys').replaceChildren(...SERIES.map(([k, l]) => el('li', 'k-' + k, el('i'), L[l])));
$('x0').textContent = L.ago(60); $('x1').textContent = L.ago(30); $('x2').textContent = L.nowLabel;
const niceMax = (v) => { if (v <= 4) return 4; const p = 10 ** Math.floor(Math.log10(v)), m = v / p; return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const hhmm = (t) => new Date(t).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
let minutes = [];
function chart(tl, now) {
  const last = Math.floor(now / 60000), byMin = new Map(tl.map((b) => [Math.floor(b.t / 60000), b]));
  minutes = Array.from({ length: 60 }, (_, i) => byMin.get(last - 59 + i) || { t: (last - 59 + i) * 60000, ok: 0, rerouted: 0, failed: 0, latencyMs: null });
  const max = niceMax(Math.max(...minutes.map((b) => b.ok + b.rerouted + b.failed)));
  $('gmax').style.top = '0'; $('gmax').firstChild.textContent = fmt(max);
  $('gmid').style.top = '50%'; $('gmid').firstChild.textContent = (max / 2).toLocaleString(lang, { maximumFractionDigits: 1 });
  const bars = $('bars');
  if (bars.children.length !== 60) bars.replaceChildren(...minutes.map((_, i) => { const b = el('div', 'bar'); b.tabIndex = i === 59 ? 0 : -1; b.dataset.i = i; return b; }));
  minutes.forEach((m, i) => {
    const col = bars.children[i];
    col.setAttribute('aria-label', hhmm(m.t) + ': ' + SERIES.map(([k, l]) => L[l] + ' ' + m[k]).join(', '));
    col.replaceChildren(...SERIES.filter(([k]) => m[k]).map(([k]) => { const seg = el('i', k); seg.style.height = (m[k] / max * 100) + '%'; return seg; }));
  });
  if (!$('tip').hidden && tipAt >= 0) tip(tipAt);
}
let tipAt = -1;
function tip(i) {
  const m = minutes[i], col = $('bars').children[i], box = $('tip');
  if (!m || !col) return;
  tipAt = i;
  box.replaceChildren(el('b', '', hhmm(m.t)), ...SERIES.map(([k, l]) => { const r = el('div', '', el('i', ''), L[l] + (lang === 'fr' ? ' : ' : ': ') + m[k]); r.firstChild.style.background = 'var(--s-' + k + ')'; return r; }),
    ...(m.latencyMs !== null ? [el('div', '', L.avgMs(fmt(m.latencyMs)))] : []));
  box.hidden = false;
  const plot = $('plot').getBoundingClientRect(), c = col.getBoundingClientRect(), half = box.offsetWidth / 2;
  box.style.left = Math.min(Math.max(c.left - plot.left + c.width / 2, half), plot.width - half) + 'px';
}
$('bars').addEventListener('pointerover', (e) => { const c = e.target.closest('.bar'); if (c) tip(Number(c.dataset.i)); });
$('bars').addEventListener('pointerleave', () => { $('tip').hidden = true; tipAt = -1; });
$('bars').addEventListener('focusin', (e) => tip(Number(e.target.dataset.i)));
$('bars').addEventListener('focusout', () => { $('tip').hidden = true; tipAt = -1; });
$('bars').addEventListener('keydown', (e) => {
  const d = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!d) return;
  e.preventDefault();
  const next = $('bars').children[Math.min(59, Math.max(0, tipAt + d))];
  for (const c of $('bars').children) c.tabIndex = -1;
  next.tabIndex = 0; next.focus();
});

function show(view) { for (const v of ['gate', 'app']) $(v).hidden = v !== view; }
async function poll() {
  clearTimeout(poll.timer);
  try {
    const r = await fetch('/stats', { headers: key ? { authorization: 'Bearer ' + key } : {}, cache: 'no-store' });
    if (r.status === 401) {
      show('gate'); $('meta').textContent = '';
      $('keymsg').textContent = key ? L.badKey : ''; $('keyinput').focus();
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    show('app');
    render(await r.json());
  } catch {
    show('app');
    $('meta').replaceChildren(el('span', 'pulse down'), L.offline);
    $('signal').className = 'signal bad'; $('title').textContent = L.down; $('text').innerHTML = L.downText;
    lastServed = null;
  }
  poll.timer = setTimeout(poll, document.hidden ? 10000 : 1500);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
poll();
`;
const DASHBOARD = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>bascule</title><style>${DASHBOARD_CSS}</style></head>
<body><main>
<div class="top">
  <div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 22h26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M9 22c6 0 8-12 20-12" fill="none" stroke="#2455d8" stroke-width="4" stroke-linecap="round"/><circle cx="9" cy="22" r="3.5" fill="#16874a"/></svg>bascule</div>
  <div class="meta" id="meta" aria-live="polite"></div>
</div>
<section id="gate" class="gate" hidden>
  <h1 id="gate-title"></h1><p id="gate-text"></p>
  <form id="keyform"><input id="keyinput" type="password" autocomplete="off" aria-labelledby="gate-text"><button id="open" type="submit"></button><p id="keymsg" class="msg" role="alert"></p></form>
</section>
<div id="app" hidden>
  <section class="hero" aria-live="polite"><span id="signal" class="signal" aria-hidden="true"></span><h1 id="title"></h1><p id="text"></p></section>
  <div class="numbers" id="numbers"></div>
  <section class="traffic" aria-labelledby="traffic-title">
    <header><div><h2 id="traffic-title"></h2><p id="traffic-lead"></p></div><ul class="keys" id="keys"></ul></header>
    <div class="plot" id="plot"><div class="grid-y" id="gmax"><span></span></div><div class="grid-y" id="gmid"><span></span></div><div class="bars" id="bars"></div><div class="tip" id="tip" hidden></div></div>
    <div class="axis-x"><span id="x0"></span><span id="x1"></span><span id="x2"></span></div>
  </section>
  <div class="section-head"><div><h2 id="lines-title"></h2><p class="lead" id="lines-lead"></p></div><ul class="legend" id="legend"></ul></div>
  <div id="lines"></div>
  <section class="connect"><div><h3 id="connect-title"></h3><p id="connect-text"></p></div><button id="copy" type="button"></button></section>
  <details id="details"><summary id="details-title"></summary><div class="tablewrap"><table><thead id="thead"></thead><tbody id="tbody"></tbody></table></div></details>
</div>
</main><script>${DASHBOARD_JS}</script></body></html>`;
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const DASHBOARD_CSP = `default-src 'none'; style-src ${sha(DASHBOARD_CSS)}; script-src ${sha(DASHBOARD_JS)}; connect-src 'self'; `
  + `form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;

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
  // The page itself holds nothing secret: it asks for the key, then reads /stats with it.
  if (req.method === 'GET' && (path === '/' || path === '/dashboard')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': DASHBOARD_CSP });
    return res.end(DASHBOARD);
  }
  // Known before auth, so even a rejected Anthropic-format client gets an error it can parse.
  res.anthropic = /^(\/v1)?\/messages(\/count_tokens)?$/.test(path);
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
      if (endpoint === 'count_tokens') {
        // No provider-neutral tokenizer: about 4 characters per token is close enough for budgeting.
        const chars = JSON.stringify([body.system, body.messages, body.tools]).length;
        return send(res, 200, { input_tokens: Math.ceil(chars / 4) });
      }
      if (endpoint === 'anthropic') {
        if (!Array.isArray(body.messages) || !body.messages.length) return send(res, 400, err('messages must be a non-empty array', 'invalid_request'));
        const oai = fromAnthropicRequest(body);
        return await route(res, oai, { endpoint: '/chat/completions', requested,
          cacheable: !oai.stream && (oai.temperature === 0 || cfg.cache?.always === true) });
      }
      if (endpoint === '/chat/completions') {
        if (!Array.isArray(body.messages) || !body.messages.length) return send(res, 400, err('messages must be a non-empty array', 'invalid_request'));
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
  console.log(`dashboard: ${localBase()}/  (or run: bascule dashboard)`);
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
warmUp();
// Editors save in bursts (truncate, write, rename): wait for the file to settle before reloading.
let reloadTimer;
for (const f of [CONFIG_PATH, ENV_PATH].filter(Boolean)) {
  watchFile(f, { interval: 1000 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => reload(`${f} changed`), 300);
  }).unref?.();
}

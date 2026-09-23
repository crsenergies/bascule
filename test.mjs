// End-to-end tests against mock providers: no network, no keys. Run: node test.mjs
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
const readJson = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = {};
const seen = {};
const servers = [];

// A mock provider: counts hits, remembers the last body and auth, delegates the answer.
// GET requests (bascule's connection warm-up, doctor's model listing) are answered apart and not counted.
const warmups = {};
async function mock(name, answer, onGet = (req, res) => json(res, { object: 'list', data: [] })) {
  hits[name] = 0; warmups[name] = 0;
  const s = await listen(async (req, res) => {
    if (req.method === 'GET') { warmups[name]++; return onGet(req, res); }
    hits[name]++;
    const body = await readJson(req);
    seen[name] = { body, auth: req.headers.authorization || req.headers['x-api-key'], path: req.url };
    await answer(req, res, body);
  });
  servers.push(s);
  return url(s);
}
const json = (res, obj, code = 200, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
const completion = (content, model = 'm') => ({ id: 'x', object: 'chat.completion', model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
const sse = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); return (obj) => res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`); };

// ---------- mock providers ----------
// A catalogue that mixes free and paid models, like OpenRouter's. Only "works:free" answers.
const catalog = await mock('catalog', (req, res, body) => body.model === 'works:free' ? json(res, completion('pong', body.model))
  : json(res, { error: { message: 'no endpoints found' } }, 404),
(req, res) => json(res, { data: [
  { id: 'kept', pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'works:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 128000 },
  { id: 'broken:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'], context_length: 256000 },
  { id: 'stealth/secret', pricing: { prompt: '0', completion: '0' }, context_length: 999000 },
  { id: 'embed-small:free', pricing: { prompt: '0', completion: '0' } },
] }));
const echo = await mock('echo', (req, res, body) => {
  if (req.url.endsWith('/embeddings')) return json(res, { object: 'list', data: [{ embedding: [0.1, 0.2] }], model: body.model });
  const last = body.messages.at(-1);
  if (body.tools && last.role === 'user' && String(last.content).includes('use the tool')) {
    const call = { id: 'call_1', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"city":"Lyon"}' } };
    if (!body.stream) return json(res, { id: 'y', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
    const w = sse(res);
    w({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Je regarde' } }] });
    w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: call.function.name, arguments: '' } }] } }] });
    w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] });
    w({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Lyon"}' } }] } }] });
    w({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    w({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } });
    return res.end('data: [DONE]\n\n');
  }
  if (!body.stream) return json(res, completion(`echo:${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}`, body.model));
  const w = sse(res);
  for (const t of ['Bon', 'jour']) w({ choices: [{ index: 0, delta: { content: t } }] });
  // Nested usage details: a naive regex would stop at the first closing brace.
  w({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } });
  res.end('data: [DONE]\n\n');
}, (req, res) => json(res, { object: 'list', data: [{ id: 'models/m' }, { id: 'only-here' }] }));
const limited = await mock('limited', (req, res) => { res.writeHead(429, { 'retry-after': '60' }); res.end('rate limited'); });
const limitedDate = await mock('limitedDate', (req, res) => { res.writeHead(429, { 'retry-after': new Date(Date.now() + 90_000).toUTCString() }); res.end('slow down'); });
const badKey = await mock('badKey', (req, res) => (req.headers.authorization === 'Bearer good' ? json(res, completion('second key')) : json(res, { error: 'bad key' }, 401)));
const invalidKey400 = (req, res) => json(res, [{ error: { code: 400, message: 'Please pass a valid API key', status: 'INVALID_ARGUMENT' } }], 400);
const badKey400 = await mock('badKey400', (req, res) => (req.headers.authorization === 'Bearer good' ? json(res, completion('ok after 400 key')) : invalidKey400(req, res)), invalidKey400);
const unpaid = await mock('unpaid', (req, res) => json(res, { message: 'Payment required to access this resource. Visit your billing tab.', type: 'payment_required' }, 402));
const broken = await mock('broken', (req, res) => json(res, { error: 'boom' }, 500));
const badReq = await mock('badReq', (req, res) => json(res, { error: { message: 'temperature must be a number' } }, 400));
const tooLong = await mock('tooLong', (req, res) => json(res, { error: { message: "This model's maximum context length is 8192 tokens" } }, 400));
const tooBig = await mock('tooBig', (req, res) => json(res, { error: 'payload too large' }, 413));
const streamErr = await mock('streamErr', (req, res) => { const w = sse(res); w({ error: { message: 'quota exceeded', code: 429 } }); res.end(); });
// Groq-style: a content-free first chunk, then the error in the stream.
const lateErr = await mock('lateErr', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
  w({ error: { message: "Tool call validation failed: attempted to call tool 'metéo'", type: 'invalid_request_error', code: 'tool_use_failed' } }); res.end(); });
const toolFail = await mock('toolFail', (req, res) => json(res, { error: { message: 'Failed to call a function. Please adjust your prompt.', type: 'invalid_request_error', code: 'tool_use_failed' } }, 400));
const blank = await mock('blank', (req, res, body) => {
  if (!body.stream) return json(res, completion(''));
  const w = sse(res); w({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }); w({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); res.end('data: [DONE]\n\n');
});
const namedErr = await mock('namedErr', (req, res) => { const w = sse(res); w({ error: { code: 'RESOURCE_EXHAUSTED', message: 'quota', details: [{ retryDelay: '40s' }] } }); res.end(); });
const streamEmpty = await mock('streamEmpty', (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); });
const streamCut = await mock('streamCut', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { content: 'par' } }] }); setTimeout(() => res.destroy(), 50); });
const streamStall = await mock('streamStall', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { content: 'a' } }] }); });
const silent = await mock('silent', () => {});
const slowBody = await mock('slowBody', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":'); });
const garbage = await mock('garbage', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>oops</html>'); });
let upstreamClosed = false;
const hang = await mock('hang', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { content: 'x' } }] }); res.on('close', () => { upstreamClosed = true; }); });
let flakyCalls = 0;
const flaky429 = await mock('flaky429', (req, res) => (++flakyCalls === 1
  ? json(res, [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.3s' }] } }], 429)
  : json(res, completion('after wait'))));
const shared = await mock('shared', async (req, res) => { await sleep(200); json(res, completion('shared')); });
let quotaCalls = 0;
const quota = await mock('quota', (req, res) => (++quotaCalls === 1
  ? json(res, [{ error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaDimensions: { location: 'global', model: 'm' }, quotaValue: '1' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.1s' }] } }], 429)
  : json(res, completion('quota ok'))));
const daily = await mock('daily', (req, res) => json(res, { error: { message: 'Rate limit exceeded: free-models-per-day', code: 429,
  metadata: { headers: { 'X-RateLimit-Limit': '50', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(Date.now() + 3 * 3600_000) } } } }, 429));
// Groq's real 413 text for a request over the per-minute token limit.
const small = await mock('small', (req, res, body) => (JSON.stringify(body.messages).length > 4000
  ? json(res, { error: { message: 'Request too large for model `m` in organization `o` service tier `on_demand` on tokens per minute (TPM): Limit 800, Requested 3082, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } }, 413)
  : json(res, completion('small ok'))));
const budget = await mock('budget', (req, res) => json(res, completion('budget')));
// Groq-like: string content only, no images. Ollama-like: no tools.
const textOnly = await mock('textOnly', (req, res, body) => (body.messages.some((m) => typeof m.content !== 'string')
  ? json(res, { error: { message: 'messages[0].content must be a string', type: 'invalid_request_error' } }, 400)
  : json(res, completion(`text:${body.messages.at(-1).content}`))));
const noTools = await mock('noTools', (req, res, body) => (body.tools
  ? json(res, { error: { message: 'registry.ollama.ai/library/m does not support tools' } }, 400)
  : json(res, completion('no tools here'))));
let slowClosed = 0;
const tortoise = await mock('tortoise', async (req, res) => { res.on('close', () => { if (!res.writableFinished) slowClosed++; }); await sleep(250); if (!res.destroyed) json(res, completion('tortoise')); });
const fast = await mock('fast', (req, res) => json(res, completion('fast')));
const slow = await mock('slow', async (req, res) => { await sleep(150); json(res, completion('slow')); });

const anthropic = await mock('anthropic', (req, res, body) => {
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { usage: { input_tokens: 7 } } });
    ev('ping', {});
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Salut' } });
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'meteo' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"ville":' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } });
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
    ev('message_stop', {});
    return res.end();
  }
  json(res, { id: 'msg1', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu1', name: 'meteo', input: { ville: 'Lyon' } }],
    stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 2 } });
});
// CRLF line endings split between writes, plus a tool delta for a block that never started.
const anthropicCrlf = await mock('anthropicCrlf', async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type, d) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...d })}\r\n\r\n`;
  const all = ev('message_start', { message: { usage: { input_tokens: 1 } } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Sa' } })
    + ev('content_block_delta', { index: 5, delta: { type: 'input_json_delta', partial_json: '{"orphan":' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lut' } })
    + ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
  // Cut right after every CR so each CRLF straddles two network chunks.
  for (const piece of all.split(/(?<=\r)/)) { res.write(piece); await sleep(2); }
  res.end();
});
const anthropicErr = await mock('anthropicErr', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
});

// ---------- router under test ----------
const dir = mkdtempSync(join(tmpdir(), 'bascule-'));
const port = 20000 + Math.floor(Math.random() * 9000);
const P = (baseUrl, extra = {}) => ({ baseUrl, keys: ['k'], models: ['m'], ...extra });
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  port, apiKey: 'secret', corsOrigins: ['http://localhost:5173'], aliases: { 'claude-haiku-*': 'quick', 'claude-*': 'smart' },
  firstByteTimeoutMs: 300, idleTimeoutMs: 300, timeoutMs: 400, maxWaitMs: 1000,
  providers: {
    echo: P(echo, { models: ['m', 'only-here'] }), limited: P(limited, { keys: ['k1', 'k2'] }), limitedDate: P(limitedDate),
    badKey: P(badKey, { keys: ['bad', 'good'] }), badKey400: P(badKey400, { keys: ['bad', 'good'] }), broken: P(broken, { keys: ['k1', 'k2', 'k3'] }), unpaid: P(unpaid), badReq: P(badReq), tooLong: P(tooLong),
    tooBig: P(tooBig), streamErr: P(streamErr), streamEmpty: P(streamEmpty), namedErr: P(namedErr), blank: P(blank), lateErr: P(lateErr), toolFail: P(toolFail), streamCut: P(streamCut), streamStall: P(streamStall),
    silent: P(silent), flaky429: P(flaky429), shared: P(shared), budget: P(budget, { rpm: 2 }), small: P(small), daily: P(daily), quota: P(quota), slowBody: P(slowBody), garbage: P(garbage), hang: P(hang), fast: P(fast), slow: P(slow), tortoise: P(tortoise), fresh: P(fast), tuned: P(fast, { minMaxTokens: 1024, params: { reasoning_effort: 'low' } }), textOnly: P(textOnly), noTools: P(noTools),
    an: P(anthropic, { type: 'anthropic', keys: ['ak'], models: ['claude'] }), anCrlf: P(anthropicCrlf, { type: 'anthropic' }), anErr: P(anthropicErr, { type: 'anthropic' }),
    off: { baseUrl: 'http://127.0.0.1:1', keys: ['${UNSET_VAR}'], models: ['x'] },
  },
  combos: {
    auto: ['limited/m', 'echo/m'], smart: ['echo/m'], quick: ['fast/m'], dated: ['limitedDate/m', 'echo/m'], keys: ['badKey/m'], keys400: ['badKey400/m'], dead: ['broken/m', 'echo/m'], unpaid: ['unpaid/m', 'echo/m'],
    badreq: ['badReq/m', 'echo/m'], toolong: ['tooLong/m', 'echo/m'], toobig: ['tooBig/m', 'echo/m'],
    serr: ['streamErr/m', 'echo/m'], sempty: ['streamEmpty/m', 'echo/m'], named: ['namedErr/m', 'echo/m'], blank: ['blank/m', 'echo/m'], late: ['lateErr/m', 'echo/m'], toolfail: ['toolFail/m', 'echo/m'], scut: ['streamCut/m', 'echo/m'], sstall: ['streamStall/m'],
    silent: ['silent/m', 'echo/m'], slowbody: ['slowBody/m', 'echo/m'], garbage: ['garbage/m', 'echo/m'], hang: ['hang/m'],
    claude: ['an/claude'], crlf: ['anCrlf/m'], anerr: ['anErr/m', 'echo/m'], allfail: ['broken/m'], all429: ['limited/m'], emb: ['an/claude', 'echo/m'],
    flaky: ['flaky429/m'], hedge: { targets: ['tortoise/m', 'fast/m'], hedgeMs: 60 }, nohedge: ['tortoise/m', 'fast/m'],
    hedgeFail: { targets: ['broken/m', 'tortoise/m'], hedgeMs: 60 }, hedgeStream: { targets: ['tortoise/m', 'echo/m'], hedgeMs: 60 }, vision: ['textOnly/m', 'echo/m'], visionNone: ['textOnly/m'], toolsc: ['noTools/m', 'echo/m'], budgeted: ['budget/m', 'echo/m'], sized: ['small/m', 'echo/m'], daily: ['daily/m', 'echo/m'], learn: ['quota/m', 'echo/m'], rr: { strategy: 'round-robin', targets: ['fast/m', 'slow/m'] }, fastest: { strategy: 'fastest', targets: ['slow/m', 'fast/m'] },
    explore: { strategy: 'fastest', targets: ['slow/m', 'fast/m', 'fresh/m'] },
  },
}));

const env = { ...process.env, BASCULE_CONFIG: join(dir, 'config.json'), BASCULE_HOME: dir, BASCULE_KEY: '', BASCULE_LOG: '0',
  BASCULE_PORT: '', BASCULE_HOST: '' };
const srv = spawn(process.execPath, [SERVER], { cwd: dir, env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => srv.stdout.once('data', ok));
const base = `http://127.0.0.1:${port}`;
const H = { 'content-type': 'application/json', authorization: 'Bearer secret' };
const post = (body, headers = {}, path = '/v1/chat/completions') => fetch(base + path, { method: 'POST', headers: { ...H, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path) => fetch(base + path, { headers: H });
const msg = (content = 'hi') => [{ role: 'user', content }];
const stats = async () => (await get('/stats')).json();
const events = (txt) => txt.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}

try {
  console.log('auth & http');
  await test('wrong key is refused', async () => assert.equal((await post({ model: 'auto', messages: msg() }, { authorization: 'Bearer nope' })).status, 401));
  await test('key of a different length is refused', async () => assert.equal((await post({ model: 'auto', messages: msg() }, { authorization: 'Bearer secretsecret' })).status, 401));
  await test('x-api-key header is accepted', async () => assert.equal((await post({ model: 'echo/m', messages: msg() }, { authorization: '', 'x-api-key': 'secret' })).status, 200));
  await test('/health needs no key', async () => assert.equal((await fetch(base + '/health')).status, 200));
  await test('dashboard page is served without a key, locked down by CSP', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'sha256-/);
    assert.ok(!/unsafe-inline/.test(csp));
    assert.match(await r.text(), /<title>bascule<\/title>/);
  });
  await test('dashboard data still needs the key', async () => assert.equal((await fetch(base + '/stats')).status, 401));
  await test('dashboard CSP hashes match the inline script and style', async () => {
    const r = await fetch(base + '/dashboard');
    const html = await r.text(), csp = r.headers.get('content-security-policy');
    const hash = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    assert.ok(csp.includes(hash(html.match(/<script>([\s\S]*)<\/script>/)[1])), 'script hash');
    assert.ok(csp.includes(hash(html.match(/<style>([\s\S]*)<\/style>/)[1])), 'style hash');
  });
  await test('stats list each combo with its resolved targets', async () => {
    const st = await stats();
    assert.deepEqual(st.combos.hedge, ['tortoise/m', 'fast/m']);
  });
  await test('stats keep a per-minute timeline of outcomes', async () => {
    const sum = (st) => st.timeline.reduce((a, b) => a + b.ok + b.rerouted + b.failed, 0);
    const before = sum(await stats());
    assert.equal((await post({ model: 'echo/m', messages: msg('timeline') })).status, 200);
    const st = await stats();
    assert.equal(sum(st), before + 1);
    assert.ok(st.timeline.length <= 60);
    assert.ok(Number.isFinite(st.timeline.at(-1).latencyMs));
  });
  await test('stats count answers per combo and target', async () => {
    const total = (st) => Object.values(st.served.nohedge || {}).reduce((a, b) => a + b, 0);
    const before = total(await stats());
    assert.equal((await post({ model: 'nohedge', messages: msg('served count') })).status, 200);
    const st = await stats();
    assert.equal(total(st), before + 1);
    assert.ok(!st.served['echo/m'], 'direct model names are not combos');
  });
  await test('bad JSON gives 400', async () => assert.equal((await post('{nope')).status, 400));
  await test('JSON that is not an object gives 400', async () => assert.equal((await post('[1,2]')).status, 400));
  await test('empty messages give 400', async () => assert.equal((await post({ model: 'auto', messages: [] })).status, 400));
  await test('unknown model gives 404', async () => assert.equal((await post({ model: 'nope', messages: msg() })).status, 404));
  await test('prototype names are not combos', async () => {
    for (const model of ['__proto__', 'constructor', 'toString']) assert.equal((await post({ model, messages: msg() })).status, 404);
  });
  await test('body over 32 MB gives 413', async () => {
    const r = await post({ model: 'echo/m', messages: msg('x'.repeat(33 * 1024 * 1024)) }).catch((e) => ({ status: 'reset:' + e.message }));
    assert.ok(r.status === 413 || String(r.status).startsWith('reset'), `got ${r.status}`);
  });
  await test('text/plain POST gives 415 (form CSRF)', async () => assert.equal((await post({ model: 'echo/m', messages: msg() }, { 'content-type': 'text/plain' })).status, 415));
  await test('foreign browser origin gives 403', async () => assert.equal((await post({ model: 'echo/m', messages: msg() }, { origin: 'https://evil.example' })).status, 403));
  await test('allowed origin gets CORS headers', async () => {
    const r = await post({ model: 'echo/m', messages: msg() }, { origin: 'http://localhost:5173' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.match(r.headers.get('access-control-expose-headers'), /x-bascule-target/);
  });
  await test('preflight from allowed origin gives 204', async () => {
    const r = await fetch(base + '/v1/chat/completions', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
    assert.equal(r.status, 204);
  });
  await test('unknown path gives 404', async () => assert.equal((await get('/v1/nothing')).status, 404));
  await test('paths without /v1 also work', async () => assert.equal((await post({ model: 'echo/m', messages: msg() }, {}, '/chat/completions')).status, 200));

  await test('connections to providers are warmed up at start', async () => {
    assert.ok(warmups.echo >= 1 && warmups.anthropic >= 1, JSON.stringify(warmups));
  });

  console.log('routing & fallback');
  await test('429 on both keys falls back to next target', async () => {
    const r = await post({ model: 'auto', messages: msg('salut   \n\n\n\ntoi') });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(j.choices[0].message.content, 'echo:salut   \n\n\n\ntoi', 'prompt text reaches the provider unchanged');
    assert.equal(hits.limited, 2);
  });
  await test('cooling target is skipped next time', async () => {
    await (await post({ model: 'auto', messages: msg() })).json();
    assert.equal(hits.limited, 2);
  });
  await test('retry-after as HTTP date is honoured', async () => {
    await (await post({ model: 'dated', messages: msg() })).json();
    await (await post({ model: 'dated', messages: msg() })).json();
    assert.equal(hits.limitedDate, 1);
    const st = await stats();
    assert.ok(st.targets['limitedDate/m#0'].coolingForS > 60, `cooling ${st.targets['limitedDate/m#0'].coolingForS}`);
  });
  await test('401 key is skipped, sibling key answers', async () => {
    const r = await post({ model: 'keys', messages: msg() });
    assert.equal((await r.json()).choices[0].message.content, 'second key');
  });
  await test('400 "invalid API key" (Gemini style) is treated as a bad key', async () => {
    const r = await post({ model: 'keys400', messages: msg() });
    assert.equal((await r.json()).choices[0].message.content, 'ok after 400 key');
  });
  await test('402 payment required falls back and parks the target for hours', async () => {
    const r = await post({ model: 'unpaid', messages: msg() });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    await (await post({ model: 'unpaid', messages: msg() })).json();
    assert.equal(hits.unpaid, 1, 'not retried while parked');
    assert.ok((await stats()).targets['unpaid/m#0'].coolingForS > 5 * 3600);
  });
  await test('500 condemns the target without trying its other keys', async () => {
    const r = await post({ model: 'dead', messages: msg() });
    assert.equal(r.status, 200);
    assert.equal(hits.broken, 1);
  });
  await test('plain 400 is returned as is, no fallback', async () => {
    const before = hits.echo;
    const r = await post({ model: 'badreq', messages: msg() });
    assert.equal(r.status, 400);
    assert.equal(hits.echo, before);
  });
  await test('400 "context too long" falls back', async () => assert.equal((await post({ model: 'toolong', messages: msg() })).status, 200));
  await test('413 falls back', async () => assert.equal((await post({ model: 'toobig', messages: msg() })).status, 200));
  await test('first-byte timeout falls back', async () => {
    const t0 = Date.now();
    const r = await post({ model: 'silent', messages: msg() });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 2000);
  });
  await test('stalled non-streaming body times out and falls back', async () => assert.equal((await post({ model: 'slowbody', messages: msg() })).status, 200));
  await test('invalid JSON from upstream falls back', async () => assert.equal((await post({ model: 'garbage', messages: msg() })).status, 200));
  await test('all targets failing gives 503', async () => assert.equal((await post({ model: 'allfail', messages: msg() })).status, 503));
  await test('only rate limits gives 429 with retry-after', async () => {
    const r = await post({ model: 'all429', messages: msg() });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
  await test('a provider-stated delay is not retried as a last resort', async () => {
    const before = hits.limited;
    assert.equal((await post({ model: 'all429', messages: msg() })).status, 429);
    assert.equal(hits.limited, before, 'no call to a target that said wait 60 s');
  });
  await test('Gemini-style retryDelay in the body is waited for, then retried', async () => {
    const t0 = Date.now();
    const r = await post({ model: 'flaky', messages: msg() });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'after wait');
    assert.ok(Date.now() - t0 >= 250, `waited ${Date.now() - t0} ms`);
    assert.equal(hits.flaky429, 2);
  });
  await test('rpm budget moves the third call of the minute to the next target', async () => {
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await post({ model: 'budgeted', messages: msg(`b${i}`) })).headers.get('x-bascule-target'));
    assert.deepEqual(got, ['budget/m', 'budget/m', 'echo/m']);
    assert.equal(hits.budget, 2);
  });
  await test('daily quota reset time (OpenRouter) parks the target until then', async () => {
    await (await post({ model: 'daily', messages: msg() })).json();
    await (await post({ model: 'daily', messages: msg() })).json();
    assert.equal(hits.daily, 1, 'no second call before the stated reset');
    assert.ok((await stats()).targets['daily/m#0'].coolingForS > 3 * 3600 - 60);
  });
  await test('"request too large" is learned: big requests skip the target, small ones still use it', async () => {
    const big = msg('x'.repeat(12000));
    let r = await post({ model: 'sized', messages: big });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(hits.small, 1);
    r = await post({ model: 'sized', messages: big });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(hits.small, 1, 'second big request must not hit the small target');
    r = await post({ model: 'sized', messages: msg('tiny') });
    assert.equal(r.headers.get('x-bascule-target'), 'small/m', 'no cooldown: small requests still go there');
    assert.equal((await stats()).targets['small/m#0'].maxTokens, 800);
  });
  await test('per-minute quota stated in a 429 is learned and respected', async () => {
    await (await post({ model: 'learn', messages: msg() })).json(); // 429 teaches rpm = 1, falls back to echo
    const st = await stats();
    assert.equal(st.targets['quota/m#0'].learnedRpm, 1);
    await sleep(150); // past retryDelay: only the learned budget can hold quota/m back now
    const r = await post({ model: 'learn', messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(hits.quota, 1, 'budget reached: no second call inside the minute');
  });
  await test('identical concurrent cacheable requests share one upstream call', async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => post({ model: 'shared/m', temperature: 0, messages: msg('same') })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(hits.shared, 1);
    assert.ok(rs.some((r) => r.headers.get('x-bascule-cache') === 'shared'));
  });
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
  await test('text-only content arrays are sent as a plain string', async () => {
    const r = await post({ model: 'textOnly/m', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'text:a\nb');
  });
  await test('model that rejects images falls back, and is skipped next time', async () => {
    const before = hits.textOnly;
    let r = await post({ model: 'vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'colour?' }, img] }] });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(hits.textOnly, before + 1);
    r = await post({ model: 'vision', messages: [{ role: 'user', content: [{ type: 'text', text: 'again' }, img] }] });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(hits.textOnly, before + 1, 'learned: no second image call to a text-only model');
    assert.deepEqual((await stats()).cannot['textOnly/m'], ['vision']);
  });
  await test('text requests still go to a model that lacks vision', async () => {
    const r = await post({ model: 'vision', messages: msg('plain') });
    assert.equal(r.headers.get('x-bascule-target'), 'textOnly/m');
  });
  await test('images with no capable target give a clear 400', async () => {
    const r = await post({ model: 'visionNone', messages: [{ role: 'user', content: [img] }] });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error.message, /no target could handle images|content must be a string/);
  });
  await test('model that rejects tools falls back to one that takes them', async () => {
    const tools = [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }];
    const r = await post({ model: 'toolsc', messages: msg(), tools });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal((await post({ model: 'toolsc', messages: msg() })).headers.get('x-bascule-target'), 'noTools/m');
  });
  await test('provider params and minMaxTokens apply, client values win', async () => {
    await (await post({ model: 'tuned/m', max_tokens: 50, messages: msg() })).json();
    assert.equal(seen.fast.body.max_tokens, 1024);
    assert.equal(seen.fast.body.reasoning_effort, 'low');
    await (await post({ model: 'tuned/m', max_tokens: 4000, reasoning_effort: 'high', messages: msg() })).json();
    assert.equal(seen.fast.body.max_tokens, 4000);
    assert.equal(seen.fast.body.reasoning_effort, 'high');
    await (await post({ model: 'fast/m', max_tokens: 50, messages: msg() })).json();
    assert.equal(seen.fast.body.max_tokens, 50, 'untuned provider keeps the client value');
    assert.ok(!('reasoning_effort' in seen.fast.body));
  });
  await test('hedged call: slow primary, fast backup wins, loser is cancelled', async () => {
    const t0 = Date.now(), before = slowClosed;
    const r = await post({ model: 'hedge', messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'fast/m');
    assert.ok(Date.now() - t0 < 220, `took ${Date.now() - t0} ms`);
    await sleep(100);
    assert.equal(slowClosed, before + 1, 'slow upstream request must be aborted');
    assert.ok((await stats()).hedges >= 1);
  });
  await test('without hedging the slow primary is awaited', async () => {
    const r = await post({ model: 'nohedge', messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'tortoise/m');
  });
  await test('hedged call: fast failure of primary still falls back normally', async () => {
    const r = await post({ model: 'hedgeFail', messages: msg() });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'tortoise/m');
  });
  await test('hedged streams work', async () => {
    const r = await post({ model: 'hedgeStream', stream: true, messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    const txt = await r.text();
    assert.equal(events(txt).map((c) => c.choices[0]?.delta?.content || '').join(''), 'Bonjour');
    assert.ok(txt.endsWith('data: [DONE]\n\n'));
  });
  await test('code indentation in prompts is preserved', async () => {
    const code = 'def f(x):\n    if x:\n        return 1';
    const j = await (await post({ model: 'echo/m', messages: msg(code) })).json();
    assert.equal(j.choices[0].message.content, `echo:${code}`);
  });
  await test('bare model name resolves to its provider', async () => {
    const r = await post({ model: 'only-here', messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/only-here');
  });
  await test('missing model uses defaultModel or 404s cleanly', async () => assert.equal((await post({ messages: msg() })).status, 404));
  await test('round-robin alternates targets', async () => {
    const a = (await post({ model: 'rr', messages: msg() })).headers.get('x-bascule-target');
    const b = (await post({ model: 'rr', messages: msg() })).headers.get('x-bascule-target');
    assert.notEqual(a, b);
  });
  await test('fastest tries an unmeasured target before settling', async () => {
    // rr above measured fast/m and slow/m; fresh/m has never been called.
    const r = await post({ model: 'explore', messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'fresh/m');
  });
  await test('fastest prefers the measured faster target', async () => {
    const r = await post({ model: 'fastest', messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'fast/m');
  });

  console.log('cache');
  await test('temperature 0 is cached', async () => {
    const before = hits.echo;
    for (let i = 0; i < 3; i++) await (await post({ model: 'echo/m', temperature: 0, messages: msg('c') })).json();
    assert.equal(hits.echo, before + 1);
  });
  await test('temperature > 0 is not cached', async () => {
    const before = hits.echo;
    for (let i = 0; i < 2; i++) await (await post({ model: 'echo/m', temperature: 0.7, messages: msg('c') })).json();
    assert.equal(hits.echo, before + 2);
  });
  await test('cache hit is flagged', async () => {
    const r = await post({ model: 'echo/m', temperature: 0, messages: msg('c') });
    assert.equal(r.headers.get('x-bascule-cache'), 'hit');
  });

  console.log('streaming');
  await test('OpenAI stream passes through and asks for usage', async () => {
    const r = await post({ model: 'auto', stream: true, messages: msg() });
    const txt = await r.text();
    assert.match(r.headers.get('content-type'), /event-stream/);
    assert.equal(events(txt).map((c) => c.choices[0]?.delta?.content || '').join(''), 'Bonjour');
    assert.ok(txt.endsWith('data: [DONE]\n\n'));
    assert.deepEqual(seen.echo.body.stream_options, { include_usage: true });
  });
  await test('nested usage in stream is counted', async () => {
    const before = (await stats()).tokens.completion;
    await (await post({ model: 'echo/m', stream: true, messages: msg() })).text();
    assert.equal((await stats()).tokens.completion, before + 2);
  });
  await test('error inside a 200 stream falls back', async () => {
    const r = await post({ model: 'serr', stream: true, messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.ok((await r.text()).includes('Bon'));
  });
  await test('in-stream error after a content-free chunk still falls back', async () => {
    const r = await post({ model: 'late', stream: true, messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    const txt = await r.text();
    assert.ok(!txt.includes('tool_use_failed') && txt.includes('Bon'));
  });
  await test('provider-rejected tool call (400 tool_use_failed) tries the next model', async () => {
    const r = await post({ model: 'toolfail', messages: msg() });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.ok(!(await stats()).cannot['toolFail/m'], 'not learned as a capability gap');
  });
  await test('empty answer (no text, no tool call) falls back, plain and stream', async () => {
    let r = await post({ model: 'blank', messages: msg('b') });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    r = await post({ model: 'blank', stream: true, messages: msg('b') });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.ok((await r.text()).includes('Bon'));
  });
  await test('named in-stream error code maps to 429 with its retry delay', async () => {
    const r = await post({ model: 'named', stream: true, messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    await r.text();
    const c = (await stats()).targets['namedErr/m#0'].coolingForS;
    assert.ok(c > 30 && c <= 40, `cooling ${c}s`);
  });
  await test('empty stream falls back', async () => {
    const r = await post({ model: 'sempty', stream: true, messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    await r.text();
  });
  await test('stream cut mid-way ends with an error event', async () => {
    const txt = await (await post({ model: 'scut', stream: true, messages: msg() })).text();
    assert.ok(txt.includes('"par"'));
    assert.ok(events(txt).some((e) => e.error), 'error event expected');
  });
  await test('stalled stream hits idle timeout with an error event', async () => {
    const t0 = Date.now();
    const txt = await (await post({ model: 'sstall', stream: true, messages: msg() })).text();
    assert.ok(Date.now() - t0 < 3000);
    assert.ok(events(txt).some((e) => e.error));
  });
  await test('client disconnect closes the upstream request', async () => {
    const ctl = new AbortController();
    const r = await post({ model: 'hang', stream: true, messages: msg() }, {}).then((x) => x);
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel();
    ctl.abort();
    await sleep(200);
    assert.ok(upstreamClosed);
  });

  console.log('anthropic translation');
  await test('system, tools, temperature clamp, empty text removed', async () => {
    const r = await post({ model: 'claude', temperature: 1.6, messages: [
      { role: 'system', content: 'sois bref' },
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'meteo?' }] }],
      tools: [{ type: 'function', function: { name: 'meteo', parameters: { type: 'object', properties: { ville: { type: 'string' } } } } }] });
    const j = await r.json();
    const b = seen.anthropic.body;
    assert.equal(b.system, 'sois bref');
    assert.equal(b.temperature, 1);
    assert.equal(b.tools[0].name, 'meteo');
    assert.deepEqual(b.messages[0].content, [{ type: 'text', text: 'meteo?' }]);
    assert.equal(seen.anthropic.auth, 'ak');
    assert.equal(j.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { ville: 'Lyon' });
    assert.equal(j.usage.total_tokens, 6);
  });
  await test('tool call and tool result map to tool_use / tool_result', async () => {
    await (await post({ model: 'claude', messages: [
      { role: 'user', content: 'meteo?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'meteo', arguments: '{"ville":"Lyon"}' } }] },
      { role: 'tool', tool_call_id: 'tu1', content: '20C' }] })).json();
    const m = seen.anthropic.body.messages;
    assert.equal(m[1].content[0].type, 'tool_use');
    assert.equal(m[2].content[0].type, 'tool_result');
  });
  await test('conversation starting with assistant gets a user turn first', async () => {
    await (await post({ model: 'claude', messages: [{ role: 'assistant', content: 'Bonjour' }, { role: 'user', content: 'x' }] })).json();
    assert.equal(seen.anthropic.body.messages[0].role, 'user');
  });
  await test('data-URL image becomes a base64 block', async () => {
    await (await post({ model: 'claude', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] })).json();
    assert.deepEqual(seen.anthropic.body.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: 'AAAA' });
  });
  await test('stream translates text, tool calls and finish reason', async () => {
    const txt = await (await post({ model: 'claude', stream: true, messages: msg() })).text();
    const ch = events(txt);
    assert.equal(ch.map((c) => c.choices[0].delta.content || '').join(''), 'Salut');
    const args = ch.flatMap((c) => c.choices[0].delta.tool_calls || []).map((t) => t.function.arguments).join('');
    assert.deepEqual(JSON.parse(args), { ville: 'Paris' });
    assert.equal(ch.at(-1).choices[0].finish_reason, 'tool_calls');
    assert.equal(ch.at(-1).usage.total_tokens, 16);
    assert.ok(txt.endsWith('data: [DONE]\n\n'));
  });
  await test('CRLF split across chunks and orphan tool delta are handled', async () => {
    const txt = await (await post({ model: 'crlf', stream: true, messages: msg() })).text();
    const ch = events(txt);
    assert.equal(ch.map((c) => c.choices[0].delta.content || '').join(''), 'Salut');
    assert.ok(ch.every((c) => (c.choices[0].delta.tool_calls || []).every((t) => Number.isInteger(t.index))), 'no tool call without index');
    assert.equal(ch.at(-1).choices[0].finish_reason, 'stop');
  });
  await test('Anthropic error event before content falls back', async () => {
    const r = await post({ model: 'anerr', stream: true, messages: msg() });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    await r.text();
  });

  console.log('anthropic-format clients (/v1/messages)');
  const amsg = (body, headers = {}) => post(body, { authorization: '', 'x-api-key': 'secret', 'anthropic-version': '2023-06-01', ...headers }, '/v1/messages');
  const aTools = [{ name: 'meteo', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
    { type: 'web_search_20250305', name: 'web_search' }];
  const aevents = (txt) => txt.split('\n\n').filter(Boolean).map((b) => ({ event: b.match(/^event: (.+)$/m)?.[1], data: JSON.parse(b.match(/^data: (.+)$/m)[1]) }));
  await test('messages: system, text and alias claude-* -> smart combo', async () => {
    const r = await amsg({ model: 'claude-sonnet-5', max_tokens: 100, system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hello' }] });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(seen.echo.body.messages[0].content, 'be brief');
    assert.equal(j.type, 'message');
    assert.equal(j.role, 'assistant');
    assert.equal(j.model, 'claude-sonnet-5');
    assert.deepEqual(j.content, [{ type: 'text', text: 'echo:hello' }]);
    assert.equal(j.stop_reason, 'end_turn');
    assert.deepEqual(j.usage, { input_tokens: 5, output_tokens: 1 });
  });
  await test('messages: claude-haiku-* alias goes to its own combo', async () => {
    const r = await amsg({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.headers.get('x-bascule-target'), 'fast/m');
  });
  await test('messages: tools map both ways, server tools dropped', async () => {
    const r = await amsg({ model: 'smart', max_tokens: 100, tools: aTools, tool_choice: { type: 'any' }, messages: [{ role: 'user', content: 'use the tool' }] });
    const j = await r.json();
    assert.deepEqual(seen.echo.body.tools.map((t) => t.function.name), ['meteo']);
    assert.equal(seen.echo.body.tool_choice, 'required');
    assert.equal(j.stop_reason, 'tool_use');
    assert.equal(j.content[0].type, 'tool_use');
    assert.equal(j.content[0].name, 'meteo');
    assert.deepEqual(j.content[0].input, { city: 'Lyon' });
  });
  await test('messages: tool_result round trip keeps OpenAI message order', async () => {
    await (await amsg({ model: 'smart', max_tokens: 100, tools: aTools, messages: [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'meteo', input: { city: 'Lyon' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '20C' }] }, { type: 'text', text: 'and tomorrow?' }] }] })).json();
    const m = seen.echo.body.messages;
    assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'tool', 'user']);
    assert.equal(m[1].tool_calls[0].id, 'toolu_1');
    assert.equal(m[2].tool_call_id, 'toolu_1');
    assert.equal(m[2].content, '20C');
    assert.equal(m[3].content, 'and tomorrow?');
  });
  await test('messages: base64 image becomes an image_url part', async () => {
    await (await amsg({ model: 'smart', max_tokens: 10, messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what?' }] }] })).json();
    assert.deepEqual(seen.echo.body.messages[0].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });
  await test('messages: stream follows the Anthropic event sequence', async () => {
    const r = await amsg({ model: 'smart', max_tokens: 100, stream: true, tools: aTools, messages: [{ role: 'user', content: 'use the tool' }] });
    assert.match(r.headers.get('content-type'), /event-stream/);
    const ev = aevents(await r.text());
    assert.deepEqual(ev.map((e) => e.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.ok(ev.every((e) => e.event === e.data.type));
    assert.equal(ev[2].data.delta.text, 'Je regarde');
    assert.equal(ev[4].data.content_block.type, 'tool_use');
    assert.equal(ev[4].data.index, 1);
    assert.deepEqual(JSON.parse(ev[5].data.delta.partial_json + ev[6].data.delta.partial_json), { city: 'Lyon' });
    assert.equal(ev[8].data.delta.stop_reason, 'tool_use');
    assert.equal(ev[8].data.usage.output_tokens, 4);
  });
  await test('messages: plain text stream', async () => {
    const ev = aevents(await (await amsg({ model: 'smart', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] })).text());
    assert.equal(ev.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join(''), 'Bonjour');
    assert.equal(ev.at(-2).data.delta.stop_reason, 'end_turn');
  });
  await test('messages: errors come back in Anthropic shape', async () => {
    let r = await amsg({ model: 'smart', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': 'wrong' });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } });
    r = await amsg({ model: 'all429', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error.type, 'rate_limit_error');
  });
  await test('messages: fallback works through the Anthropic endpoint too', async () => {
    const r = await amsg({ model: 'auto', max_tokens: 10, messages: [{ role: 'user', content: 'fb' }] });
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal((await r.json()).content[0].text, 'echo:fb');
  });
  await test('count_tokens answers an estimate', async () => {
    const r = await post({ model: 'smart', messages: [{ role: 'user', content: 'x'.repeat(400) }] }, {}, '/v1/messages/count_tokens');
    const j = await r.json();
    assert.ok(j.input_tokens >= 100 && j.input_tokens < 130, JSON.stringify(j));
  });
  await test('OpenAI SDK clients do not see alias names as models', async () => {
    assert.equal((await post({ model: 'claude-sonnet-5', messages: msg() })).headers.get('x-bascule-target'), 'echo/m', 'aliases apply to both formats');
  });

  console.log('other endpoints');
  await test('embeddings are routed, Anthropic targets skipped', async () => {
    const r = await post({ model: 'emb', input: 'bonjour' }, {}, '/v1/embeddings');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(seen.echo.path, '/embeddings');
    assert.ok(!('stream' in seen.echo.body), 'no stream field sent to embeddings');
  });
  await test('embedding failure does not bench the model for chat', async () => {
    assert.equal((await post({ model: 'dead', input: 'x' }, {}, '/v1/embeddings')).status, 200); // broken/m fails on embeddings
    const st = await stats();
    assert.ok(st.targets['embeddings:broken/m#0'] || st.targets['embeddings:broken/m#1'] || st.targets['embeddings:broken/m#2']);
    assert.ok(Object.keys(st.targets).some((id) => id.startsWith('broken/m#')), 'chat health kept separately');
  });
  await test('models list shows combos and enabled providers only', async () => {
    const ids = (await (await get('/v1/models')).json()).data.map((m) => m.id);
    assert.ok(ids.includes('auto') && ids.includes('an/claude') && !ids.includes('off/x'));
  });
  await test('stats count requests, fallbacks, cache hits', async () => {
    const st = await stats();
    assert.ok(st.requests > 20 && st.fallbacks > 5 && st.cacheHits >= 3 && st.version);
  });

  console.log('load');
  await test('300 concurrent requests all succeed', async () => {
    const rs = await Promise.all(Array.from({ length: 300 }, (_, i) => post({ model: 'echo/m', messages: msg(`n${i}`) }).then((r) => r.json())));
    assert.ok(rs.every((j, i) => j.choices?.[0].message.content === `echo:n${i}`));
  });
  await test('100 concurrent streams all complete', async () => {
    const txts = await Promise.all(Array.from({ length: 100 }, () => post({ model: 'echo/m', stream: true, messages: msg() }).then((r) => r.text())));
    assert.ok(txts.every((t) => t.endsWith('data: [DONE]\n\n')));
  });
  // RSS after a burst reflects V8's heap high-water mark, not a leak. A leak shows as growth
  // that keeps going across identical rounds, so compare later rounds with the first.
  await test('no memory growth across repeated load rounds', async () => {
    if (process.platform === 'win32') return; // no ps on Windows
    const rss = () => Number(spawnSync('ps', ['-o', 'rss=', '-p', String(srv.pid)]).stdout.toString().trim()) / 1024;
    const round = () => Promise.all(Array.from({ length: 200 }, (_, i) => post({ model: 'echo/m', stream: i % 2 === 0, messages: msg(`r${i}`) }).then((r) => r.text())));
    for (let i = 0; i < 3; i++) await round();
    const first = rss();
    for (let i = 0; i < 12; i++) await round();
    const last = rss();
    console.log(`       rss ${first.toFixed(0)} MB after 600 requests, ${last.toFixed(0)} MB after 3000`);
    assert.ok(last < first * 1.5 + 20, `grew from ${first.toFixed(0)} to ${last.toFixed(0)} MB`);
  });

  console.log('cli & process');
  const run = (args, extra = {}) => spawnSync(process.execPath, [SERVER, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 5000 });
  await test('--version prints the package version', async () => {
    assert.equal(run(['--version']).stdout.trim(), JSON.parse(readFileSync(join(dirname(SERVER), 'package.json'))).version);
  });
  await test('unknown argument exits 2', async () => assert.equal(run(['--nope']).status, 2));
  await test('init writes config and a private .env with a random key', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-home-'));
    assert.equal(run(['init'], { BASCULE_HOME: home }).status, 0);
    if (process.platform !== 'win32') assert.equal(statSync(join(home, '.env')).mode & 0o777, 0o600); // no POSIX modes on Windows
    assert.match(readFileSync(join(home, '.env'), 'utf8'), /^BASCULE_KEY=[0-9a-f]{48}$/m);
    JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  });
  await test('public bind without a strong key refuses to start', async () => {
    assert.equal(run([], { BASCULE_HOST: '0.0.0.0', BASCULE_KEY: 'change-me' }).status, 1);
  });
  await test('port already in use exits with a clear message', async () => {
    const r = run([], { BASCULE_PORT: String(port) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /already in use/);
  });
  await test('.env parsing handles export, quotes and inline comments', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-env-'));
    const p3 = port + 2;
    writeFileSync(join(home, '.env'), `export BASCULE_PORT=${p3}\nA_KEY="quoted # kept"\nB_KEY=plain # comment\r\n`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ providers: { p: { baseUrl: echo, keys: ['${A_KEY}|${B_KEY}'], models: ['m'] } } }));
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BASCULE_|A_KEY$|B_KEY$)/.test(k)));
    const s3 = spawn(process.execPath, [SERVER], { cwd: home, env: { ...clean, BASCULE_HOME: home, BASCULE_LOG: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((ok) => s3.stdout.once('data', ok));
    try {
      const r = await fetch(`http://127.0.0.1:${p3}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'p/m', messages: msg() }) });
      assert.equal(r.status, 200, 'exported BASCULE_PORT must be used');
      assert.equal(seen.echo.auth, 'Bearer quoted # kept|plain');
    } finally { s3.kill(); }
  });
  await test('status prints live stats of the running router', async () => {
    const r = run(['status']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /requests \d+/);
    assert.match(r.stdout, /echo\/m#0 +ok +\d+/);
  });
  await test('doctor reports keys, listed and missing models, dead combos', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-doc-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ providers: {
      good: { baseUrl: echo, keys: ['k'], models: ['m', 'retired'] },
      bad: { baseUrl: badKey400, keys: ['sk-or-v1-misplaced'], models: ['m'] },
      down: { baseUrl: 'http://127.0.0.1:1', keys: ['k'], models: ['m'] },
      nokey: { baseUrl: echo, keys: ['${NOPE_UNSET}'], models: ['m'] } },
      combos: { ok: ['good/m'], dead: ['nokey/m'] } }));
    // Async spawn: spawnSync would block this process, and with it the mock providers doctor calls.
    const r = await new Promise((ok) => {
      const c = spawn(process.execPath, [SERVER, 'doctor', '--deep'], { cwd: dir, env: { ...env, BASCULE_CONFIG: join(home, 'config.json') } });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
      c.on('exit', (status) => ok({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /✓ +good key 1 \(…k\)/);
    assert.match(r.stdout, /m: listed, answers/);
    assert.match(r.stdout, /retired: NOT LISTED/);
    assert.match(r.stdout, /✗ +bad key 1 .*invalid key.*looks like a openrouter key: move it to the OPENROUTER_API_KEY line/);
    assert.match(r.stdout, /✗ +down key 1 .*unreachable/);
    assert.match(r.stdout, /nokey: no key set/);
    assert.match(r.stdout, /combo dead: 0\/1 .*unusable/);
  });
  await test('config edits are reloaded live; a broken edit keeps the old config', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-reload-'));
    const cfgPath = join(home, 'config.json'), p4 = port + 3;
    const write = (combos) => writeFileSync(cfgPath, JSON.stringify({ port: p4, providers: { e: { baseUrl: echo, keys: ['k'], models: ['m'] } }, combos }));
    write({ one: ['e/m'] });
    const s4 = spawn(process.execPath, [SERVER], { cwd: home, env: { ...env, BASCULE_CONFIG: cfgPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((ok) => s4.stdout.once('data', ok));
    const call = (model) => fetch(`http://127.0.0.1:${p4}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: msg() }) }).then((r) => r.status);
    try {
      assert.equal(await call('two'), 404);
      await sleep(1100); write({ one: ['e/m'], two: ['e/m'] });
      for (let i = 0; i < 40 && (await call('two')) !== 200; i++) await sleep(100);
      assert.equal(await call('two'), 200, 'new combo live without restart');
      await sleep(1100); writeFileSync(cfgPath, '{ broken json');
      await sleep(1800);
      assert.equal(await call('two'), 200, 'broken edit must not take the router down');
    } finally { s4.kill(); }
  });
  await test('learned capabilities survive a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-state-'));
    const p5 = port + 4;
    const cfgPath = join(home, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ port: p5, providers: { t: { baseUrl: textOnly, keys: ['k'], models: ['m'] }, e: { baseUrl: echo, keys: ['k'], models: ['m'] } },
      combos: { v: ['t/m', 'e/m'] } }));
    const start = async () => {
      const c = spawn(process.execPath, [SERVER], { cwd: home, env: { ...env, BASCULE_CONFIG: cfgPath, BASCULE_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((ok) => c.stdout.once('data', ok));
      return c;
    };
    const ask = () => fetch(`http://127.0.0.1:${p5}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'v', messages: [{ role: 'user', content: [img] }] }) });
    let c = await start();
    await (await ask()).text();
    c.kill('SIGTERM'); await new Promise((ok) => c.on('exit', ok));
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).cannot, { 't/m': ['vision'] });
    const before = hits.textOnly;
    c = await start();
    try {
      await (await ask()).text();
      assert.equal(hits.textOnly, before, 'restarted router must remember t/m has no vision');
    } finally { c.kill(); }
  });
  await test('costs are counted per price, the daily budget keeps only free targets, spend survives a restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-cost-'));
    const p6 = port + 5;
    const cfgPath = join(home, 'config.json');
    // echo answers with 5 prompt and 1 completion tokens: at $1M per million each, one answer costs $6.
    writeFileSync(cfgPath, JSON.stringify({ port: p6, providers: { paid: { baseUrl: echo, keys: ['k'], models: ['m'] }, free: { baseUrl: echo, keys: ['k'], models: ['m'] } },
      prices: { 'paid/*': [1e6, 1e6] }, budget: { dailyUsd: 5 }, combos: { mix: ['paid/m', 'free/m'], paidOnly: ['paid/m'] } }));
    const start = async () => {
      const c = spawn(process.execPath, [SERVER], { cwd: home, env: { ...env, BASCULE_CONFIG: cfgPath, BASCULE_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((ok) => c.stdout.once('data', ok));
      return c;
    };
    const b6 = `http://127.0.0.1:${p6}`;
    const ask = (model) => fetch(`${b6}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: msg('cost') }) });
    const cost = async () => (await (await fetch(`${b6}/stats`)).json()).cost;
    let c = await start();
    try {
      assert.equal((await ask('mix')).headers.get('x-bascule-target'), 'paid/m');
      let k = await cost();
      assert.equal(k.usd, 6);
      assert.equal(k.byTarget['paid/m'], 6);
      assert.equal(k.capped, true);
      assert.deepEqual(k.priced, ['paid/m']);
      const r = await ask('mix');
      assert.equal(r.headers.get('x-bascule-target'), 'free/m', 'over budget: paid target skipped');
      await r.text();
      assert.equal((await cost()).usd, 6, 'free target costs nothing');
      const refused = await ask('paidOnly');
      assert.equal(refused.status, 402);
      assert.match((await refused.json()).error.message, /daily budget/);
    } finally { c.kill('SIGTERM'); await new Promise((ok) => c.on('exit', ok)); }
    c = await start();
    try { assert.equal((await cost()).usd, 6, 'spend of the day survives a restart'); }
    finally { c.kill(); }
  });
  await test('discover finds retired and free models; --apply keeps only those that answer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bascule-disc-'));
    const cfgPath = join(home, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ providers: {
      cat: { baseUrl: catalog, keys: ['${CAT_KEY}'], models: ['kept', 'gone'] },
      local: { baseUrl: echo, requiresKey: false, models: ['m'] } },
    combos: { auto: { hedgeMs: 5, targets: ['cat/kept', 'cat/gone', 'local/m'] }, other: ['cat/gone', 'local/m'] } }, null, 2));
    const run = (args) => new Promise((ok) => {
      const c = spawn(process.execPath, [SERVER, 'discover', ...args], { cwd: home, env: { ...env, BASCULE_CONFIG: cfgPath, CAT_KEY: 'k' } });
      let stdout = '', stderr = '';
      c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
      c.on('exit', (status) => ok({ status, stdout, stderr }));
    });
    let r = await run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cat: 5 models listed, 2 free/);
    assert.match(r.stdout, /retired: gone/);
    assert.match(r.stdout, /new: +broken:free +\(free, tools, 256k context\)/);
    assert.ok(!/stealth|embed/.test(r.stdout), 'stealth and non-chat models are never offered');
    assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).providers.cat.models.length, 2, 'dry run writes nothing');
    r = await run(['--apply']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /broken:free skipped: 404/);
    const out = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(out.providers.cat.models, ['kept', 'works:free']);
    assert.equal(out.providers.cat.keys[0], '${CAT_KEY}', 'variables stay unexpanded');
    assert.deepEqual(out.combos.auto, { hedgeMs: 5, targets: ['cat/kept', 'cat/works:free', 'local/m'] }, 'free model goes before the local fallback');
    assert.deepEqual(out.combos.other, ['local/m']);
    assert.equal(JSON.parse(readFileSync(cfgPath + '.bak', 'utf8')).providers.cat.models.length, 2, 'backup of the previous config');
  });
  await test('SIGTERM stops the server within 5 s', async () => {
    const p2 = port + 1;
    const s2 = spawn(process.execPath, [SERVER], { cwd: dir, env: { ...env, BASCULE_PORT: String(p2) }, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((ok) => s2.stdout.once('data', ok));
    const t0 = Date.now();
    s2.kill('SIGTERM');
    await new Promise((ok) => s2.on('exit', ok));
    assert.ok(Date.now() - t0 < 5500);
  });
} finally {
  srv.kill();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
console.log('ALL TESTS PASSED');

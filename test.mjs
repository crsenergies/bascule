// End-to-end tests against mock providers: no network, no keys. Run: node test.mjs
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
const readJson = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hits = {};
const seen = {};
const servers = [];

// A mock provider: counts hits, remembers the last body and auth, delegates the answer.
async function mock(name, answer) {
  hits[name] = 0;
  const s = await listen(async (req, res) => {
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
const echo = await mock('echo', (req, res, body) => {
  if (req.url.endsWith('/embeddings')) return json(res, { object: 'list', data: [{ embedding: [0.1, 0.2] }], model: body.model });
  if (!body.stream) return json(res, completion(`echo:${body.messages.at(-1).content}`, body.model));
  const w = sse(res);
  for (const t of ['Bon', 'jour']) w({ choices: [{ index: 0, delta: { content: t } }] });
  // Nested usage details: a naive regex would stop at the first closing brace.
  w({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } });
  res.end('data: [DONE]\n\n');
});
const limited = await mock('limited', (req, res) => { res.writeHead(429, { 'retry-after': '60' }); res.end('rate limited'); });
const limitedDate = await mock('limitedDate', (req, res) => { res.writeHead(429, { 'retry-after': new Date(Date.now() + 90_000).toUTCString() }); res.end('slow down'); });
const badKey = await mock('badKey', (req, res) => (req.headers.authorization === 'Bearer good' ? json(res, completion('second key')) : json(res, { error: 'bad key' }, 401)));
const broken = await mock('broken', (req, res) => json(res, { error: 'boom' }, 500));
const badReq = await mock('badReq', (req, res) => json(res, { error: { message: 'temperature must be a number' } }, 400));
const tooLong = await mock('tooLong', (req, res) => json(res, { error: { message: "This model's maximum context length is 8192 tokens" } }, 400));
const tooBig = await mock('tooBig', (req, res) => json(res, { error: 'payload too large' }, 413));
const streamErr = await mock('streamErr', (req, res) => { const w = sse(res); w({ error: { message: 'quota exceeded', code: 429 } }); res.end(); });
const streamEmpty = await mock('streamEmpty', (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); });
const streamCut = await mock('streamCut', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { content: 'par' } }] }); setTimeout(() => res.destroy(), 50); });
const streamStall = await mock('streamStall', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { content: 'a' } }] }); });
const silent = await mock('silent', () => {});
const slowBody = await mock('slowBody', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":'); });
const garbage = await mock('garbage', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>oops</html>'); });
let upstreamClosed = false;
const hang = await mock('hang', (req, res) => { const w = sse(res); w({ choices: [{ index: 0, delta: { content: 'x' } }] }); res.on('close', () => { upstreamClosed = true; }); });
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
  port, apiKey: 'secret', corsOrigins: ['http://localhost:5173'],
  firstByteTimeoutMs: 300, idleTimeoutMs: 300, timeoutMs: 400,
  providers: {
    echo: P(echo, { models: ['m', 'only-here'] }), limited: P(limited, { keys: ['k1', 'k2'] }), limitedDate: P(limitedDate),
    badKey: P(badKey, { keys: ['bad', 'good'] }), broken: P(broken, { keys: ['k1', 'k2', 'k3'] }), badReq: P(badReq), tooLong: P(tooLong),
    tooBig: P(tooBig), streamErr: P(streamErr), streamEmpty: P(streamEmpty), streamCut: P(streamCut), streamStall: P(streamStall),
    silent: P(silent), slowBody: P(slowBody), garbage: P(garbage), hang: P(hang), fast: P(fast), slow: P(slow),
    an: P(anthropic, { type: 'anthropic', keys: ['ak'], models: ['claude'] }), anCrlf: P(anthropicCrlf, { type: 'anthropic' }), anErr: P(anthropicErr, { type: 'anthropic' }),
    off: { baseUrl: 'http://127.0.0.1:1', keys: ['${UNSET_VAR}'], models: ['x'] },
  },
  combos: {
    auto: ['limited/m', 'echo/m'], dated: ['limitedDate/m', 'echo/m'], keys: ['badKey/m'], dead: ['broken/m', 'echo/m'],
    badreq: ['badReq/m', 'echo/m'], toolong: ['tooLong/m', 'echo/m'], toobig: ['tooBig/m', 'echo/m'],
    serr: ['streamErr/m', 'echo/m'], sempty: ['streamEmpty/m', 'echo/m'], scut: ['streamCut/m', 'echo/m'], sstall: ['streamStall/m'],
    silent: ['silent/m', 'echo/m'], slowbody: ['slowBody/m', 'echo/m'], garbage: ['garbage/m', 'echo/m'], hang: ['hang/m'],
    claude: ['an/claude'], crlf: ['anCrlf/m'], anerr: ['anErr/m', 'echo/m'], allfail: ['broken/m'], all429: ['limited/m'], emb: ['an/claude', 'echo/m'],
    rr: { strategy: 'round-robin', targets: ['fast/m', 'slow/m'] }, fastest: { strategy: 'fastest', targets: ['slow/m', 'fast/m'] },
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

  console.log('routing & fallback');
  await test('429 on both keys falls back to next target', async () => {
    const r = await post({ model: 'auto', messages: msg('salut   \n\n\n\ntoi') });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(j.choices[0].message.content, 'echo:salut\n\ntoi', 'whitespace compacted');
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
  await test('only rate limits gives 429', async () => assert.equal((await post({ model: 'all429', messages: msg() })).status, 429));
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

  console.log('other endpoints');
  await test('embeddings are routed, Anthropic targets skipped', async () => {
    const r = await post({ model: 'emb', input: 'bonjour' }, {}, '/v1/embeddings');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-bascule-target'), 'echo/m');
    assert.equal(seen.echo.path, '/embeddings');
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

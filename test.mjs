// End-to-end test with mock upstreams. Run: node test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const listen = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => ok(s)); });
const readJson = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(JSON.parse(b))); });
const hits = { dead: 0, openai: 0, anthropic: 0 };

const dead = await listen((req, res) => { hits.dead++; res.writeHead(429, { 'retry-after': '60' }); res.end('rate limited'); });

const openai = await listen(async (req, res) => {
  hits.openai++;
  const body = await readJson(req);
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const w of ['Bon', 'jour']) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: w } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: `echo:${body.messages.at(-1).content}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
});

let lastAnthropic;
const anthropic = await listen(async (req, res) => {
  hits.anthropic++;
  const body = (lastAnthropic = await readJson(req));
  assert.equal(req.headers['x-api-key'], 'ak');
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, d) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`);
    ev('message_start', { message: { usage: { input_tokens: 7 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Salut' } });
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'meteo' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"ville":' } });
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } });
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } });
    ev('message_stop', {});
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg1', content: [{ type: 'text', text: 'ok' },
    { type: 'tool_use', id: 'tu1', name: 'meteo', input: { ville: 'Lyon' } }],
    stop_reason: 'tool_use', usage: { input_tokens: 4, output_tokens: 2 } }));
});

const url = (s) => `http://127.0.0.1:${s.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'bascule-'));
const port = 20000 + Math.floor(Math.random() * 9000);
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  port, apiKey: 'secret',
  providers: {
    dead: { baseUrl: url(dead), keys: ['k1', 'k2'], models: ['m'] },
    oa: { baseUrl: url(openai), keys: ['k'], models: ['m'] },
    an: { type: 'anthropic', baseUrl: url(anthropic), keys: ['ak'], models: ['claude'] },
    off: { baseUrl: 'http://127.0.0.1:1', keys: ['${UNSET_VAR}'], models: ['x'] },
  },
  combos: { auto: ['dead/m', 'oa/m'], claude: ['an/claude'], broken: ['dead/m'] },
}));

const srv = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, BASCULE_CONFIG: join(dir, 'config.json'), BASCULE_KEY: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((ok) => srv.stdout.once('data', ok));
const base = `http://127.0.0.1:${port}`;
const post = (body, key = 'secret') => fetch(`${base}/v1/chat/completions`, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });

try {
  // auth
  assert.equal((await post({ model: 'auto', messages: [] }, 'wrong')).status, 401);

  // fallback: dead (both keys 429) -> oa
  let r = await post({ model: 'auto', messages: [{ role: 'user', content: 'salut   \n\n\n\ntoi' }] });
  let j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-bascule-target'), 'oa/m');
  assert.equal(j.choices[0].message.content, 'echo:salut\n\ntoi'); // whitespace compacted
  assert.equal(hits.dead, 2);

  // cooled keys are skipped on next call
  await (await post({ model: 'auto', messages: [{ role: 'user', content: 'a' }] })).json();
  assert.equal(hits.dead, 2, 'cooled provider must not be hit first');

  // cache (temperature 0)
  const before = hits.openai;
  for (let i = 0; i < 2; i++) await (await post({ model: 'oa/m', temperature: 0, messages: [{ role: 'user', content: 'c' }] })).json();
  assert.equal(hits.openai, before + 1);

  // OpenAI stream passthrough
  r = await post({ model: 'auto', stream: true, messages: [{ role: 'user', content: 's' }] });
  let txt = await r.text();
  assert.match(r.headers.get('content-type'), /event-stream/);
  assert.ok(txt.includes('"Bon"') && txt.includes('[DONE]'));

  // Anthropic non-stream translation incl. tools + system
  r = await post({ model: 'claude', messages: [{ role: 'system', content: 'sois bref' }, { role: 'user', content: 'meteo?' }],
    tools: [{ type: 'function', function: { name: 'meteo', parameters: { type: 'object', properties: { ville: { type: 'string' } } } } }] });
  j = await r.json();
  assert.equal(lastAnthropic.system, 'sois bref');
  assert.equal(lastAnthropic.tools[0].name, 'meteo');
  assert.equal(j.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments), { ville: 'Lyon' });
  assert.equal(j.usage.total_tokens, 6);

  // Anthropic tool-result round trip mapping
  await (await post({ model: 'claude', messages: [
    { role: 'user', content: 'meteo?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'meteo', arguments: '{"ville":"Lyon"}' } }] },
    { role: 'tool', tool_call_id: 'tu1', content: '20C' }] })).json();
  assert.equal(lastAnthropic.messages[1].content[0].type, 'tool_use');
  assert.equal(lastAnthropic.messages[2].content[0].type, 'tool_result');

  // Anthropic stream translation
  r = await post({ model: 'claude', stream: true, messages: [{ role: 'user', content: 'x' }] });
  txt = await r.text();
  const chunks = txt.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks.map((c) => c.choices[0].delta.content || '').join(''), 'Salut');
  const args = chunks.flatMap((c) => c.choices[0].delta.tool_calls || []).map((t) => t.function.arguments).join('');
  assert.deepEqual(JSON.parse(args), { ville: 'Paris' });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(txt.endsWith('data: [DONE]\n\n'));

  // all targets failed -> 503
  r = await post({ model: 'broken', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 503);

  // unknown model, models list, disabled provider hidden, stats
  assert.equal((await post({ model: 'nope', messages: [] })).status, 404);
  const models = (await (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer secret' } })).json()).data.map((m) => m.id);
  assert.ok(models.includes('auto') && models.includes('an/claude') && !models.includes('off/x'));
  const st = await (await fetch(`${base}/stats`, { headers: { authorization: 'Bearer secret' } })).json();
  assert.ok(st.fallbacks >= 1 && st.cacheHits === 1);

  // CSRF guards: foreign browser origin and form-style content types are refused
  r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret', origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'oa/m', messages: [] }),
    headers: { 'content-type': 'text/plain', authorization: 'Bearer secret' } });
  assert.equal(r.status, 415);

  // Public bind without a strong key refuses to start
  const pub = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, BASCULE_CONFIG: join(dir, 'config.json'),
    BASCULE_KEY: 'change-me', HOST: '0.0.0.0' }, stdio: 'ignore' });
  assert.equal(await new Promise((ok) => pub.on('exit', ok)), 1);

  console.log('ALL TESTS PASSED');
} finally {
  srv.kill(); dead.close(); openai.close(); anthropic.close();
}

#!/usr/bin/env node
// Refuses to let a key leave this machine: run before every commit, push and npm publish.
// Scans what would be shared (tracked or staged files, and the npm package) for the values in the
// local .env and for anything shaped like a provider key.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });

// Public key formats. Long enough that test placeholders like "sk-or-v1-misplaced" do not match.
const SHAPES = [
  ['OpenRouter', /sk-or-v1-[a-f0-9]{32,}/], ['Anthropic', /sk-ant-[A-Za-z0-9_-]{32,}/], ['OpenAI', /sk-(proj|svcacct)-[A-Za-z0-9_-]{32,}/],
  ['OpenAI', /\bsk-[A-Za-z0-9]{40,}/], ['Groq', /gsk_[A-Za-z0-9]{40,}/], ['Cerebras', /csk-[a-z0-9]{40,}/], ['Google', /AIza[0-9A-Za-z_-]{35}/],
  ['Google', /AQ\.Ab[0-9A-Za-z_-]{30,}/], ['Hugging Face', /hf_[A-Za-z0-9]{30,}/], ['GitHub', /gh[pousr]_[A-Za-z0-9]{36,}/],
];
// Values of the local .env, the real keys. Short or empty ones cannot be told apart from ordinary text.
const secrets = [join(ROOT, '.env'), join(process.env.HOME || '', '.bascule', '.env')].filter(existsSync)
  .flatMap((f) => readFileSync(f, 'utf8').split(/\r?\n/))
  .map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*["']?\s*(.*?)\s*["']?\s*$/))
  .filter((m) => m && m[2].length >= 12).map((m) => ({ name: m[1], value: m[2] }));

const staged = process.argv.includes('--staged');
const files = new Set(run('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files']).split('\n').filter(Boolean));
if (!staged) {
  try { for (const f of JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']))[0].files) files.add(f.path); }
  catch { console.error('secrets-check: cannot list the npm package (npm pack failed), checking git files only'); }
}

const problems = [];
for (const f of files) {
  if (/(^|\/)\.env$/.test(f)) { problems.push(`${f}: this is the keys file, it must never be shared`); continue; }
  let text;
  // Staged content is what the commit will hold, which may differ from the working copy.
  try { text = staged ? run('git', ['show', `:${f}`]) : readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  for (const { name, value } of secrets) if (text.includes(value)) problems.push(`${f}: contains the value of ${name} from your .env`);
  for (const [who, re] of SHAPES) if (re.test(text)) problems.push(`${f}: contains something shaped like a ${who} key`);
}

if (problems.length) {
  console.error(`secrets-check: BLOCKED, a key would leave this machine\n  ${problems.join('\n  ')}\nMove keys to .env (never committed) and try again.`);
  process.exit(1);
}
console.log(`secrets-check: ok, ${files.size} file${files.size === 1 ? '' : 's'} checked against ${secrets.length} local key${secrets.length === 1 ? '' : 's'} and ${SHAPES.length} key formats`);

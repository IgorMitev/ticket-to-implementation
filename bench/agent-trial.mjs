// Behavioral context trial for maintainers. Runs a fresh headless Claude Code main agent on the
// offline TRIAL-1 fixture with scripted user replies, then records measured token usage, observed
// instruction loads and gate outcomes. Costs real model usage; run deliberately.
//
//   node bench/agent-trial.mjs run --label baseline [--runs 3] [--model claude-haiku-5-5]
//        [--effort low] [--skill-dir DIR] [--max-turns 8] [--max-budget-usd 5]
//   node bench/agent-trial.mjs compare baseline candidate
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createAgentTrial } from '../tests/create-agent-trial.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const resultsRoot = join(here, 'results');
const RUNTIME = ['SKILL.md', 'references', 'scripts'];

export const replies = {
  approval: 'I approve the presented summary. Proceed with implementation.',
  punctuation: 'Remove punctuation other than hyphens, collapse repeated hyphens into one, and trim leading and trailing hyphens.',
  fallback: 'Proceed with your recommendation; ask me only when a product decision is needed.',
};

// Picks the simulated user's reply from controller state and the agent's last message.
export function chooseReply(status, text) {
  if (status?.proposal) return { kind: 'approval', text: replies.approval };
  if (/punctuation/i.test(text)) return { kind: 'punctuation', text: replies.punctuation };
  return { kind: 'fallback', text: replies.fallback };
}

// Aggregates usage from stream-json events. Token totals come from each invocation's result
// `usage`; per-message output counts are partial streaming values. `total_cost_usd` is
// cumulative across resumes of one session, so the largest value is the session cost.
// Assistant events repeat per content block, so requests are deduplicated by message id and
// used only for request counts and peak context. Subagent events carry parent_tool_use_id.
export function summarizeEvents(events, skillDir) {
  const requests = new Map(), loads = { main: new Set(), worker: new Set() }, tools = { main: 0, worker: 0 };
  const total = { input_uncached: 0, cache_write: 0, cache_read: 0, output: 0, thinking: 0 };
  let cost = 0, turns = 0, duration = 0;
  for (const e of events) {
    if (e.type === 'result') {
      cost = Math.max(cost, e.total_cost_usd ?? 0); turns += e.num_turns ?? 0; duration += e.duration_ms ?? 0;
      const u = e.usage ?? {};
      total.input_uncached += u.input_tokens ?? 0; total.cache_write += u.cache_creation_input_tokens ?? 0;
      total.cache_read += u.cache_read_input_tokens ?? 0; total.output += u.output_tokens ?? 0;
      total.thinking += u.output_tokens_details?.thinking_tokens ?? 0;
    }
    if (e.type !== 'assistant' || !e.message) continue;
    const thread = e.parent_tool_use_id ? 'worker' : 'main';
    if (e.message.id && e.message.usage) requests.set(e.message.id, { thread, usage: e.message.usage });
    for (const block of e.message.content ?? []) {
      if (block.type !== 'tool_use') continue;
      tools[thread]++;
      const target = block.input?.file_path ?? block.input?.command ?? '';
      for (const m of String(target).matchAll(/[\w./-]*(SKILL\.md|references\/[\w.-]+\.md)/g)) {
        const path = m[0].startsWith('/') ? relative(skillDir, m[0]) : m[0].slice(m[0].indexOf(m[1]));
        if (!path.startsWith('..')) loads[thread].add(path);
      }
    }
  }
  const usage = { total, main: blank(), worker: blank() };
  for (const { thread, usage: u } of requests.values()) {
    const t = usage[thread], context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    t.requests++; t.peak_context = Math.max(t.peak_context, context);
  }
  return { usage, tool_calls: tools, cost_usd: Math.round(cost * 1e4) / 1e4, model_turns: turns, duration_ms: duration,
    observed_loads: { main: [...loads.main].sort(), worker: [...loads.worker].sort() } };
}
const blank = () => ({ requests: 0, peak_context: 0 });

function claude(args, cwd) {
  return new Promise((done, fail) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '', stderr = ''; const events = [];
    child.stdout.on('data', chunk => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) if (line.trim()) try { events.push(JSON.parse(line)); } catch { /* non-JSON noise */ }
    });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', fail);
    child.on('close', code => code === 0 || events.some(e => e.type === 'result') ? done(events) : fail(new Error(`claude exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

function status(skillDir, trial) {
  try {
    return JSON.parse(execFileSync(process.execPath, [join(skillDir, 'scripts/workflow.mjs'), 'status', trial.key,
      '--out', trial.work_directory, '--format', 'compact'], { encoding: 'utf8' }));
  } catch { return null; }
}

async function handoffModes(work) {
  const files = (await readdir(work, { recursive: true })).filter(f => f.endsWith('handoff.json'));
  return Promise.all(files.map(async f => JSON.parse(await readFile(join(work, f), 'utf8')).mode));
}

async function outcomes(skillDir, trial, final, transcript) {
  const repo = trial.repository;
  const testsPass = (() => { try { execFileSync(process.execPath, ['--test'], { cwd: repo, stdio: 'pipe' }); return true; } catch { return false; } })();
  const notes = execFileSync('cat', [join(repo, 'notes.txt')], { encoding: 'utf8' });
  const approvalIndex = transcript.findIndex(t => t.reply === 'approval');
  const punctuationIndex = transcript.findIndex(t => t.reply === 'punctuation');
  return {
    done: final?.done ?? false, outcome: final?.outcome ?? null, next_phase: final?.next_phase ?? null,
    tests_pass: testsPass, user_edit_preserved: notes.includes('User draft: preserve this line.'),
    asked_punctuation_before_approval: punctuationIndex >= 0 && (approvalIndex < 0 || punctuationIndex < approvalIndex),
    approval_requested: approvalIndex >= 0,
    handoff_modes: await handoffModes(trial.work_directory),
    exception_codes: (final?.exceptions ?? []).map(e => e.code),
  };
}

async function runOnce({ skillDir, model, effort, maxTurns, budget, index, label }) {
  const trial = await createAgentTrial();
  const installed = join(trial.root, '.claude', 'skills', 'ticket-to-implementation');
  for (const entry of RUNTIME) await cp(join(skillDir, entry), join(installed, entry), { recursive: true });
  const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, ...(effort ? ['--effort', effort] : []),
    '--permission-mode', 'bypassPermissions', '--setting-sources', 'project', '--strict-mcp-config',
    ...(budget ? ['--max-budget-usd', String(budget)] : [])];
  let prompt = `/ticket-to-implementation ${trial.key} --out ${trial.work_directory}\nRepository: ${trial.repository}\nImplement this ticket.`;
  const events = [], transcript = []; let session = null;
  for (let turn = 0; turn < maxTurns; turn++) {
    const batch = await claude([...base, ...(session ? ['--resume', session] : []), prompt], trial.root);
    events.push(...batch);
    const result = batch.findLast(e => e.type === 'result');
    session = result?.session_id ?? session;
    const current = status(installed, trial);
    if (current?.done || !session) break;
    const reply = chooseReply(current, result?.result ?? '');
    transcript.push({ turn, reply: reply.kind, next_phase: current?.next_phase ?? null });
    prompt = reply.text;
  }
  const final = status(installed, trial);
  const record = { label, run: index, model, effort: effort ?? null, skill_dir: skillDir, trial_root: trial.root, session_id: session,
    user_turns: transcript.length + 1, transcript, outcomes: await outcomes(installed, trial, final, transcript),
    ...summarizeEvents(events, installed) };
  const dir = join(resultsRoot, label); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `run-${index}.json`), JSON.stringify(record, null, 2) + '\n');
  await writeFile(join(dir, `run-${index}.events.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  return record;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };

export function summarize(records) {
  const pick = f => median(records.map(f));
  const rate = f => `${records.filter(f).length}/${records.length}`;
  return {
    runs: records.length,
    'main peak context': pick(r => r.usage.main.peak_context),
    'main requests': pick(r => r.usage.main.requests),
    'worker peak context': pick(r => r.usage.worker.peak_context),
    'worker requests': pick(r => r.usage.worker.requests),
    'total cache read': pick(r => r.usage.total.cache_read),
    'total cache write': pick(r => r.usage.total.cache_write),
    'total uncached input': pick(r => r.usage.total.input_uncached),
    'total output': pick(r => r.usage.total.output),
    'total thinking': pick(r => r.usage.total.thinking),
    'cost usd': pick(r => r.cost_usd),
    'user turns': pick(r => r.user_turns),
    'tool calls main': pick(r => r.tool_calls.main),
    'tool calls worker': pick(r => r.tool_calls.worker),
    'gate: done': rate(r => r.outcomes.done),
    'gate: tests pass': rate(r => r.outcomes.tests_pass),
    'gate: user edit kept': rate(r => r.outcomes.user_edit_preserved),
    'gate: asked punctuation first': rate(r => r.outcomes.asked_punctuation_before_approval),
    'gate: approval requested': rate(r => r.outcomes.approval_requested),
    'delegated to subagent': rate(r => r.outcomes.handoff_modes?.includes('subagent')),
  };
}

async function load(label) {
  const dir = join(resultsRoot, label);
  const files = (await readdir(dir)).filter(f => /^run-\d+\.json$/.test(f));
  return Promise.all(files.map(async f => JSON.parse(await readFile(join(dir, f), 'utf8'))));
}

async function compareLabels(a, b) {
  const [ra, rb] = await Promise.all([load(a), load(b)]);
  const sa = summarize(ra), sb = summarize(rb);
  const rows = Object.keys(sa).map(k => {
    const d = typeof sa[k] === 'number' && typeof sb[k] === 'number' ? sb[k] - sa[k] : null;
    return [k, String(sa[k]), String(sb[k]), d == null ? '' : `${d > 0 ? '+' : ''}${Math.round(d * 1e4) / 1e4}${sa[k] ? ` (${d > 0 ? '+' : ''}${Math.round(1000 * d / sa[k]) / 10}%)` : ''}`];
  });
  const head = ['metric (median)', a, b, 'delta']; const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  console.log([head, ...rows].map(r => r.map((c, i) => i ? c.padStart(w[i]) : c.padEnd(w[i])).join('  ')).join('\n'));
  const loads = rs => [...new Set(rs.flatMap(r => [...r.observed_loads.main.map(p => `main:${p}`), ...r.observed_loads.worker.map(p => `worker:${p}`)]))].sort();
  console.log(`\nObserved loads ${a}: ${loads(ra).join(', ') || '-'}\nObserved loads ${b}: ${loads(rb).join(', ') || '-'}`);
  console.log('\nMedians over few runs are noisy: treat small deltas as inconclusive and check gates before savings.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    label: { type: 'string' }, runs: { type: 'string', default: '3' }, model: { type: 'string', default: 'claude-haiku-5-5' },
    effort: { type: 'string' }, 'skill-dir': { type: 'string' }, 'max-turns': { type: 'string', default: '8' }, 'max-budget-usd': { type: 'string' },
  } });
  const [command, ...rest] = positionals;
  if (command === 'run') {
    if (!values.label) throw new Error('--label is required');
    const skillDir = resolve(values['skill-dir'] ?? join(here, '..'));
    for (let i = 1; i <= Number(values.runs); i++) {
      const r = await runOnce({ skillDir, model: values.model, effort: values.effort, maxTurns: Number(values['max-turns']),
        budget: values['max-budget-usd'], index: i, label: values.label });
      console.log(JSON.stringify({ run: i, cost_usd: r.cost_usd, main_peak: r.usage.main.peak_context, outcomes: r.outcomes }));
    }
  } else if (command === 'compare' && rest.length === 2) await compareLabels(...rest);
  else console.log('Usage: node bench/agent-trial.mjs run --label NAME [--runs 3 --model M --skill-dir DIR]\n       node bench/agent-trial.mjs compare LABEL_A LABEL_B');
}

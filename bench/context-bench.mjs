// Deterministic context benchmark for maintainers. Not used when resolving a ticket.
// Measures declared instruction loads, CLI output and generated packets, and checks
// that required safeguards stay reachable. Sizes are bytes; tokens are bytes/4 estimates.
//
//   node bench/context-bench.mjs                      # print current metrics
//   node bench/context-bench.mjs --save               # write bench/baseline.json
//   node bench/context-bench.mjs --compare            # compare with bench/baseline.json
//   node bench/context-bench.mjs --skill-dir DIR      # measure another checkout
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = bytes => Math.round(bytes / 4);

function section(text, anchor) {
  const slug = h => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^#+\s/.test(l) && slug(l.replace(/^#+\s/, '')) === anchor);
  if (start < 0) throw new Error(`Missing section #${anchor}`);
  const level = lines[start].match(/^#+/)[0].length;
  let end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level);
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

async function loadEntry(skillDir, entry) {
  const [file, anchor] = entry.split('#');
  const text = await readFile(join(skillDir, file), 'utf8');
  return anchor ? section(text, anchor) : text;
}

export async function staticMetrics(skillDir, benchDir = here) {
  const sets = JSON.parse(await readFile(join(benchDir, 'load-sets.json'), 'utf8'));
  const { safeguards } = JSON.parse(await readFile(join(benchDir, 'safeguards.json'), 'utf8'));
  const loads = {}, texts = {};
  for (const [name, entries] of Object.entries(sets)) {
    if (name.startsWith('_')) continue;
    const parts = await Promise.all(entries.map(e => loadEntry(skillDir, e)));
    texts[name] = parts.join('\n');
    const bytes = Buffer.byteLength(texts[name]);
    loads[name] = { bytes, tokens_est: tokens(bytes), files: entries.length };
  }
  const missing = [];
  for (const s of safeguards)
    for (const set of s.sets)
      if (!texts[set]) missing.push({ id: s.id, set, problem: 'unknown load set' });
      else if (!new RegExp(s.pattern, 'i').test(texts[set])) missing.push({ id: s.id, set, problem: 'pattern not found' });
  return { loads, safeguards: { checked: safeguards.length, missing } };
}

// Runs the documented CLI commands (default output format) against offline fixtures and records printed output size.
export async function cliMetrics(skillDir) {
  const scenarios = {};
  for (const kind of ['feature', 'bug']) scenarios[kind] = await runScenario(skillDir, kind);
  return scenarios;
}

async function runScenario(skillDir, kind) {
  const { newProgress } = await import(pathToFileURL(join(skillDir, 'scripts/state.mjs')));
  const root = await mkdtemp(join(tmpdir(), 'context-bench-'));
  try {
    const out = join(root, 'ticket'), repo = join(root, 'repo');
    await mkdir(out); await mkdir(repo);
    await writeFile(join(repo, 'app.js'), 'export const enabled = false;\n');
    await writeFile(join(out, 'identity.json'), JSON.stringify({ key: 'BENCH-1' }));
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ issue_key: 'BENCH-1', snapshot_sha256: 'bench', status: 'complete', attachments: [], errors: [], fetched_at: '2026-11-15T00:00:00Z' }));
    await writeFile(join(out, 'ticket.md'), '# BENCH-1\n\nFixture ticket.\n');
    await writeFile(join(out, 'progress.json'), JSON.stringify(await newProgress('BENCH-1', out)));
    let n = 0;
    const input = async data => { const p = join(root, `input-${n++}.json`); await writeFile(p, JSON.stringify(data)); return p; };
    const calls = [];
    const cli = (action, opts = {}) => {
      const args = [join(skillDir, 'scripts/workflow.mjs'), action, 'BENCH-1', '--out', out];
      if (opts.phase) args.push('--phase', opts.phase);
      if (opts.input) args.push('--input', opts.input);
      const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' });
      calls.push({ step: `${action}${opts.phase ? ' ' + opts.phase : ''}`, bytes: Buffer.byteLength(stdout) });
      return JSON.parse(stdout);
    };
    const artifact = async (name, text = 'Observed fixture evidence') => {
      const p = JSON.parse(await readFile(join(out, 'progress.json'), 'utf8'));
      const path = join(p.artifact_directory, name); await writeFile(path, text); return path;
    };
    const step = async (phase, data, draft = true) => {
      const { phase_token } = cli('start', { phase });
      if (draft) cli('draft', { phase });
      return cli('complete', { phase, input: await input({ phase_token, summary: `${phase} findings`, artifacts: [await artifact(`${phase}.md`)], exceptions: [], ...data }) });
    };
    cli('configure', { input: await input({ kind, scope: 'implement', repository: repo, user_request: 'Implement BENCH-1' }) });
    cli('status');
    await step('evidence_review', { attachments: [], no_video_reason: 'No video attachments' });
    await step('investigation', {
      current_behavior: 'Behavior disabled', relevant_files: ['app.js'],
      ...(kind === 'bug'
        ? { reproduction: { status: 'reproduced', attempted_locally: true, environment: 'local fixture', target: 'local fixture process', steps: ['Run example'], expected: 'Enabled', actual: 'Disabled', evidence: [await artifact('local-repro.log', 'Local run: expected enabled, observed disabled')] } }
        : { feature_analysis: 'Enable via existing module', constraints: [] }),
    });
    const { phase_token } = cli('start', { phase: 'clarification' });
    cli('draft', { phase: 'clarification' });
    const report = { phase_token, summary: 'Enable the behavior', artifacts: [await artifact('clarification.md')], exceptions: [],
      acceptance_criteria: [{ id: 'AC1', requirement: 'Behavior is enabled', verification: 'Run tests' }], scope_exclusions: [], questions: [] };
    const presented = cli('present', { phase: 'clarification', input: await input(report) });
    cli('complete', { phase: 'clarification', input: await input({ ...report, alignment: { status: 'confirmed_by_user', proposal_id: presented.proposal.id, rationale: 'Approved', user_response: 'Approved' } }) });
    const impl = cli('start', { phase: 'implementation' });
    const handoff = cli('handoff', { phase: 'implementation', input: await input({ phase_token: impl.phase_token, mode: 'subagent' }) });
    cli('assert', { phase: 'implementation' });
    const packet = await readFile(handoff.assignment.path, 'utf8');
    const binding = await readFile(handoff.assignment.binding_path, 'utf8');
    const workerDraft = execFileSync(process.execPath, [join(skillDir, 'scripts/workflow.mjs'), 'draft', 'BENCH-1', '--out', out,
      '--phase', 'implementation', '--input', handoff.assignment.binding_path], { encoding: 'utf8' });
    const total = calls.reduce((s, c) => s + c.bytes, 0);
    return {
      cli_calls: calls.length, cli_bytes: total, cli_tokens_est: tokens(total), calls,
      handoff_bytes: Buffer.byteLength(packet), handoff_tokens_est: tokens(Buffer.byteLength(packet)),
      binding_bytes: Buffer.byteLength(binding), worker_draft_bytes: Buffer.byteLength(workerDraft),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function bench(skillDir) {
  return { skill_dir: skillDir, ...(await staticMetrics(skillDir)), cli: await cliMetrics(skillDir) };
}

function flatten(result) {
  const rows = {};
  for (const [k, v] of Object.entries(result.loads)) rows[`load ${k}`] = v.bytes;
  for (const [k, v] of Object.entries(result.cli)) {
    rows[`cli ${k} total`] = v.cli_bytes;
    rows[`cli ${k} calls`] = v.cli_calls;
    rows[`handoff ${k}`] = v.handoff_bytes;
    rows[`worker draft ${k}`] = v.worker_draft_bytes;
  }
  return rows;
}

export function compare(baseline, current) {
  const a = flatten(baseline), b = flatten(current);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].map(metric => {
    const before = a[metric] ?? null, after = b[metric] ?? null;
    const delta = before != null && after != null ? after - before : null;
    return { metric, before, after, delta, pct: delta != null && before ? Math.round(1000 * delta / before) / 10 : null };
  });
}

function table(rows) {
  const fmt = v => v == null ? '-' : String(v);
  const lines = rows.map(r => [r.metric, fmt(r.before), fmt(r.after), r.delta == null ? '-' : (r.delta > 0 ? '+' : '') + r.delta, r.pct == null ? '-' : (r.pct > 0 ? '+' : '') + r.pct + '%']);
  const head = ['metric', 'baseline', 'current', 'delta', '%'];
  const w = head.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)));
  return [head, ...lines].map(l => l.map((c, i) => i ? c.padStart(w[i]) : c.padEnd(w[i])).join('  ')).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: {
    'skill-dir': { type: 'string' }, save: { type: 'boolean' }, compare: { type: 'boolean' },
    baseline: { type: 'string' }, json: { type: 'boolean' },
  } });
  const skillDir = resolve(values['skill-dir'] ?? join(here, '..'));
  const baselinePath = resolve(values.baseline ?? join(here, 'baseline.json'));
  const result = await bench(skillDir);
  const { skill_dir, ...stored } = result;
  if (values.save) await writeFile(baselinePath, JSON.stringify(stored, null, 2) + '\n');
  if (values.compare) {
    if (!existsSync(baselinePath)) throw new Error(`No baseline at ${baselinePath}; run with --save first`);
    console.log(table(compare(JSON.parse(await readFile(baselinePath, 'utf8')), result)));
  } else if (values.json) console.log(JSON.stringify(stored, null, 2));
  else console.log(table(compare(result, result).map(r => ({ ...r, before: null, delta: null, pct: null }))));
  const { missing } = result.safeguards;
  if (missing.length) {
    console.error(`\nMissing safeguards (${missing.length}):`);
    for (const m of missing) console.error(`- ${m.id} in ${m.set}: ${m.problem}`);
    process.exitCode = 1;
  } else console.log(`\nSafeguards: ${result.safeguards.checked} reachable in their load sets.`);
}

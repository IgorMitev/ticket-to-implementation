#!/usr/bin/env node
// Per-turn token usage of Cursor agents (for example Grok trials started through T3 Code).
// Reads Cursor's local agent store with the sqlite3 CLI. Cursor records usage for the main
// agent only: subagent turns are reported as transcripts without token counts.
//
//   node bench/cursor-usage.mjs [--project DIR] [--json] AGENT_ID_PREFIX...
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function projectKey(dir) {
  return dir.replace(/^\/+/, '').replace(/[^A-Za-z0-9]+/g, '-');
}

export function sumUsage(turns) {
  const total = { input: 0, cache_read: 0, input_uncached: 0, output: 0, reasoning: 0, total: 0 };
  for (const t of turns) for (const k of Object.keys(total)) total[k] += t[k] ?? 0;
  return total;
}

export function parseUsage(json) {
  const u = JSON.parse(json || '{}');
  const input = u.inputTokens ?? 0, cacheRead = u.cacheReadTokens ?? 0;
  return { input, cache_read: cacheRead, input_uncached: input - cacheRead, output: u.outputTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0, total: u.totalTokens ?? input + (u.outputTokens ?? 0) };
}

function sql(db, query) {
  const out = execFileSync('sqlite3', ['-json', db, query], { encoding: 'utf8' }).trim();
  return out ? JSON.parse(out) : [];
}

export function agentUsage(projectDir, prefix) {
  const store = join(projectDir, 'sdk-agent-store');
  const like = prefix.replace(/'/g, "''");
  for (const shard of existsSync(store) ? readdirSync(store) : []) {
    const db = join(store, shard, 'index.db');
    if (!existsSync(db)) continue;
    const rows = sql(db, `select agent_id, turn_number, model, status, usage_json from runs where agent_id like '${like}%' order by turn_number`);
    if (!rows.length) continue;
    const agent = rows[0].agent_id;
    const turns = rows.map(r => ({ turn: r.turn_number, model: r.model, status: r.status, ...parseUsage(r.usage_json) }));
    const subDir = join(projectDir, 'agent-transcripts', agent, 'subagents');
    const subagents = existsSync(subDir) ? readdirSync(subDir).filter(f => f.endsWith('.jsonl')).length : 0;
    return { agent, turns, total: sumUsage(turns), unmeasured_subagents: subagents };
  }
  return null;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const p = args.indexOf('--project');
  const project = p >= 0 ? args.splice(p, 2)[1] : process.cwd();
  const ids = args.filter(a => !a.startsWith('--'));
  if (!ids.length) { console.error('usage: cursor-usage.mjs [--project DIR] [--json] AGENT_ID_PREFIX...'); process.exit(2); }
  const dir = join(homedir(), '.cursor', 'projects', projectKey(project));
  const results = ids.map(id => agentUsage(dir, id) ?? { agent: id, missing: true });
  if (json) { console.log(JSON.stringify(results, null, 1)); process.exit(0); }
  for (const r of results) {
    if (r.missing) { console.log(`${r.agent}: not found under ${dir}`); continue; }
    console.log(`${r.agent} (${r.turns[0]?.model})`);
    for (const t of [...r.turns, { turn: 'total', ...r.total }])
      console.log(`  turn ${String(t.turn).padEnd(5)} total ${String(t.total).padStart(9)}  uncached ${String(t.input_uncached).padStart(8)}  cache_read ${String(t.cache_read).padStart(9)}  output ${String(t.output).padStart(7)}  reasoning ${String(t.reasoning).padStart(7)}`);
    if (r.unmeasured_subagents) console.log(`  + ${r.unmeasured_subagents} subagent transcript(s) without recorded usage`);
  }
}

#!/usr/bin/env node
// Token usage of Codex trial sessions (for example Luna or Sol started through T3 Code).
// Codex writes one rollout file per session, including spawned subagents, with cumulative
// token_count events. Sessions are matched by a marker such as the trial fixture root.
//
//   node bench/codex-usage.mjs [--sessions DIR] [--json] MARKER...
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function rollouts(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...rollouts(path));
    else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

export function sessionUsage(lines) {
  let meta = null, total = null, peak = 0, requests = 0, model = null, firstUser = null;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const p = event.payload ?? {};
    if (event.type === 'session_meta') meta = p;
    if (event.type === 'turn_context' && p.model) model = p.model;
    if (event.type === 'response_item' && p.type === 'message' && p.role === 'user')
      firstUser = (firstUser ?? '') + (p.content ?? []).map(c => c.text ?? '').join('') + '\n';
    if (event.type === 'event_msg' && p.type === 'token_count' && p.info) {
      total = p.info.total_token_usage;
      const last = p.info.last_token_usage;
      if (last) { requests++; peak = Math.max(peak, last.input_tokens ?? 0); }
    }
  }
  const t = total ?? {};
  const input = t.input_tokens ?? 0, cached = t.cached_input_tokens ?? 0;
  return {
    id: meta?.id, model, source: meta?.thread_source ?? null, user_text: firstUser,
    requests, peak_context: peak,
    usage: { input_uncached: input - cached, cache_read: cached, output: t.output_tokens ?? 0,
      reasoning: t.reasoning_output_tokens ?? 0, total: t.total_tokens ?? input + (t.output_tokens ?? 0) },
  };
}

// The session whose user messages name the marker and the skill command is the main
// agent; every other session mentioning the marker (spawned workers) is a worker.
export function trialUsage(sessions, marker) {
  const matched = sessions.filter(s => s.text.includes(marker)).map(s => { const { user_text, ...u } = sessionUsage(s.text.split('\n')); return { ...u, user_text, file: s.file }; });
  const isMain = s => (s.user_text ?? '').includes(marker) && (s.user_text ?? '').includes('/ticket-to-implementation TRIAL');
  const main = matched.filter(isMain), workers = matched.filter(s => !isMain(s));
  const sum = list => list.reduce((a, s) => { for (const k of Object.keys(a)) a[k] += s.usage[k]; return a; },
    { input_uncached: 0, cache_read: 0, output: 0, reasoning: 0, total: 0 });
  return { marker, main: { sessions: main.length, peak_context: Math.max(0, ...main.map(s => s.peak_context)), requests: main.reduce((a, s) => a + s.requests, 0), ...sum(main) },
    worker: { sessions: workers.length, peak_context: Math.max(0, ...workers.map(s => s.peak_context)), requests: workers.reduce((a, s) => a + s.requests, 0), ...sum(workers) },
    total: sum(matched), model: main[0]?.model ?? matched[0]?.model ?? null };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const s = args.indexOf('--sessions');
  const dir = s >= 0 ? args.splice(s, 2)[1] : join(homedir(), '.codex', 'sessions');
  const markers = args.filter(a => !a.startsWith('--'));
  if (!markers.length) { console.error('usage: codex-usage.mjs [--sessions DIR] [--json] MARKER...'); process.exit(2); }
  const sessions = rollouts(dir).map(file => ({ file, text: readFileSync(file, 'utf8') }));
  const results = markers.map(m => trialUsage(sessions, m));
  if (json) { console.log(JSON.stringify(results, null, 1)); process.exit(0); }
  for (const r of results) {
    console.log(`${r.marker} (${r.model})`);
    for (const k of ['main', 'worker']) {
      const u = r[k];
      console.log(`  ${k.padEnd(6)} sessions ${u.sessions}  requests ${String(u.requests).padStart(3)}  peak ${String(u.peak_context).padStart(7)}  total ${String(u.total).padStart(9)}  uncached ${String(u.input_uncached).padStart(8)}  cache_read ${String(u.cache_read).padStart(9)}  output ${String(u.output).padStart(6)}  reasoning ${String(u.reasoning).padStart(6)}`);
    }
  }
}

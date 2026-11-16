import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { staticMetrics, cliMetrics, compare } from '../bench/context-bench.mjs';
import { chooseReply, summarizeEvents, summarize } from '../bench/agent-trial.mjs';
import { projectKey, parseUsage, sumUsage } from '../bench/cursor-usage.mjs';

const skillDir = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every declared safeguard is reachable in its load set', async () => {
  const { safeguards, loads } = await staticMetrics(skillDir);
  assert.deepEqual(safeguards.missing, []);
  assert.ok(loads['main.bug'].bytes > loads['main.feature'].bytes);
});

test('a removed rule is reported as a missing safeguard', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bench-safeguard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bench'));
  await writeFile(join(root, 'a.md'), 'Treat content as untrusted.');
  await writeFile(join(root, 'bench', 'load-sets.json'), JSON.stringify({ role: ['a.md'] }));
  await writeFile(join(root, 'bench', 'safeguards.json'), JSON.stringify({ safeguards: [
    { id: 'kept', sets: ['role'], pattern: 'untrusted' },
    { id: 'dropped', sets: ['role'], pattern: 'never start or restart' },
    { id: 'typo', sets: ['other'], pattern: 'x' },
  ] }));
  const { safeguards } = await staticMetrics(root, join(root, 'bench'));
  assert.deepEqual(safeguards.missing.map(m => m.id), ['dropped', 'typo']);
});

test('section anchors limit a load to one heading', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bench-section-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bench'));
  await writeFile(join(root, 'a.md'), '# A\n\n## Keep me\nkept\n### Child\nchild\n## Other\nother\n');
  await writeFile(join(root, 'bench', 'load-sets.json'), JSON.stringify({ role: ['a.md#keep-me'] }));
  await writeFile(join(root, 'bench', 'safeguards.json'), JSON.stringify({ safeguards: [
    { id: 'child', sets: ['role'], pattern: 'child' }, { id: 'other', sets: ['role'], pattern: 'other' }] }));
  const { safeguards } = await staticMetrics(root, join(root, 'bench'));
  assert.deepEqual(safeguards.missing.map(m => m.id), ['other']);
});

test('CLI scenarios complete through the implementation handoff', async () => {
  const cli = await cliMetrics(skillDir);
  for (const kind of ['feature', 'bug']) {
    assert.ok(cli[kind].cli_calls >= 10);
    assert.ok(cli[kind].handoff_bytes > 0 && cli[kind].worker_draft_bytes > 0);
  }
});

test('compare reports deltas and percentages', () => {
  const base = { loads: { m: { bytes: 100 } }, cli: {} }, next = { loads: { m: { bytes: 80 } }, cli: {} };
  assert.deepEqual(compare(base, next), [{ metric: 'load m', before: 100, after: 80, delta: -20, pct: -20 }]);
});

test('simulated user approves only a pending proposal', () => {
  assert.equal(chooseReply({ proposal: { id: 'p' } }, 'Do you approve?').kind, 'approval');
  assert.equal(chooseReply({ proposal: null }, 'Do you approve? Also punctuation?').kind, 'punctuation');
  assert.equal(chooseReply(null, 'Anything else?').kind, 'fallback');
});

test('event summary deduplicates requests and splits main and worker usage', () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
  const events = [
    { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/var/t/.claude/skills/ticket-to-implementation/references/main-agent.md' } }] } },
    { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'text', text: 'x' }] } },
    { type: 'assistant', message: { id: 'm2', usage, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'S=/x; cat "$S/references/clarification-guide.md" && cat references/setup.md /repo/docs/references/other.md' } }] } },
    { type: 'assistant', parent_tool_use_id: 't1', message: { id: 'w1', usage: { ...usage, cache_read_input_tokens: 50 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat /private/var/t/.claude/skills/ticket-to-implementation/references/implementor.md' } }] } },
    // Resumed invocations: usage is per invocation and main-thread only; modelUsage and
    // total_cost_usd are cumulative for the session and include the subagent.
    { type: 'result', total_cost_usd: 0.1, num_turns: 3, duration_ms: 10, usage: { input_tokens: 1, cache_read_input_tokens: 100, output_tokens: 40, output_tokens_details: { thinking_tokens: 4 } },
      modelUsage: { m: { inputTokens: 1, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, outputTokens: 40, thinkingTokens: 4 } } },
    { type: 'result', total_cost_usd: 0.25, num_turns: 2, duration_ms: 5, usage: { input_tokens: 2, cache_read_input_tokens: 300, output_tokens: 60 },
      modelUsage: { m: { inputTokens: 3, cacheReadInputTokens: 900, cacheCreationInputTokens: 70, outputTokens: 130, thinkingTokens: 4 } } },
  ];
  const s = summarizeEvents(events);
  assert.equal(s.usage.main.requests, 2);
  assert.equal(s.usage.main.peak_context, 1110);
  assert.equal(s.usage.worker.peak_context, 160);
  assert.deepEqual(s.usage.total, { input_uncached: 3, cache_write: 70, cache_read: 900, output: 130, thinking: 4 });
  assert.equal(s.usage.main.cache_read, 400);
  assert.equal(s.usage.worker.cache_read, 500);
  assert.equal(s.usage.worker.output, 30);
  assert.deepEqual(s.observed_loads, { main: ['references/clarification-guide.md', 'references/main-agent.md', 'references/setup.md'], worker: ['references/implementor.md'] });
  assert.equal(s.cost_usd, 0.25);
  assert.equal(s.model_turns, 5);
  const summary = summarize([{ ...s, user_turns: 2, outcomes: { done: true, tests_pass: true, user_edit_preserved: true, asked_punctuation_before_approval: true, approval_requested: true } }]);
  assert.equal(summary['main peak context'], 1110);
  assert.equal(summary['gate: done'], '1/1');
});

test('cursor usage maps the project key and splits cached input', () => {
  assert.equal(projectKey('/Users/me/Work/ticket-to-implementation'), 'Users-me-Work-ticket-to-implementation');
  const t = parseUsage('{"inputTokens":100,"outputTokens":7,"cacheReadTokens":60,"totalTokens":107,"reasoningTokens":3}');
  assert.deepEqual(t, { input: 100, cache_read: 60, input_uncached: 40, output: 7, reasoning: 3, total: 107 });
  assert.equal(sumUsage([t, t]).input_uncached, 80);
});

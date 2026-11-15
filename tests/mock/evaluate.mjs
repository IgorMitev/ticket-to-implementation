import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(process.argv[2]);
const config = JSON.parse(await readFile(join(root, 'run.json')));
const { workflow } = await import(pathToFileURL(join(config.skill, 'scripts/workflow.mjs')));
const status = await workflow('status', config.key, { out: config.work_directory }, { env: {} });
assert.equal(status.done, true); assert.equal(status.outcome, 'complete');
const { slug } = await import(pathToFileURL(join(config.repository, 'slug.mjs')));
for (const [input, expected] of [[' Example ', 'example'], [' A\t B\nC ', 'a-b-c'], ['', ''], [' \t\n', ''], [' A_B! C? ', 'a_b!-c?'], ['MiXeD', 'mixed']]) assert.equal(slug(input), expected);
assert.equal(await readFile(join(config.repository, 'notes.txt'), 'utf8'), 'Existing project note.\nUser draft: preserve this line.\n');
execFileSync(process.execPath, ['--test'], { cwd: config.repository, stdio: 'pipe' });
const progress = JSON.parse(await readFile(join(config.work_directory, 'progress.json')));
const accepted = {};
for (const [name, phase] of Object.entries(progress.phases)) {
  assert.equal(phase.status, 'complete', name);
  accepted[name] = JSON.parse(await readFile(phase.result_file));
}
assert.equal(accepted.evidence_review.attachments.find(a => a.id === '42')?.disposition, 'reviewed');
assert.equal(accepted.clarification.alignment.status, 'confirmed_by_user');
assert.ok(accepted.verification.verification_receipts.length);
console.log(JSON.stringify({ passed: true, done: status.done, outcome: status.outcome,
  phases: Object.keys(accepted), criteria: accepted.clarification.acceptance_criteria,
  alignment: accepted.clarification.alignment,
  implementation_context: accepted.clarification.implementation_context ?? null }, null, 2));

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verify } from '../scripts/verify.mjs';
import { workflow } from '../scripts/workflow.mjs';
import { session } from '../scripts/session.mjs';
import { acquireLock, newProgress } from '../scripts/state.mjs';
import { validateBinding } from '../scripts/handoff.mjs';
import { json, hashFile } from '../scripts/lib.mjs';

async function fixture(t, { kind = 'feature', scope = 'implement', partial = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-scenario-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'ticket'), repo = join(root, 'repo');
  await mkdir(out); await mkdir(repo);
  await writeFile(join(repo, 'app.js'), 'export const enabled = false;\n');
  await writeFile(join(out, 'identity.json'), JSON.stringify({ key: 'APP-1' }));
  const manifest = { issue_key: 'APP-1', snapshot_sha256: 'snapshot-one', status: partial ? 'partial' : 'complete', attachments: [], errors: partial ? [{ stage: 'comments', error: 'Unavailable' }] : [], fetched_at: '2026-11-11T00:00:00Z' };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(out, 'ticket.md'), 'Example ticket');
  const progress = await newProgress('APP-1', out);
  await writeFile(join(out, 'progress.json'), JSON.stringify(progress));
  const input = async data => {
    const path = join(root, 'input.json');
    await writeFile(path, JSON.stringify(data)); return path;
  };
  const call = (action, options = {}) => workflow(action, 'APP-1', { out, ...options }, { env: {} });
  await call('configure', { input: await input({ kind, scope, repository: repo, user_request: `Please ${scope} APP-1` }) });
  const artifact = async (name, contents = 'Observed supporting evidence') => {
    const p = await json(join(out, 'progress.json'));
    const path = join(p.artifact_directory, name); await writeFile(path, contents); return path;
  };
  const start = phase => call('start', { phase });
  const binding = async () => {
    const a = (await call('status')).assignment;
    return a ? { assignment_id: a.assignment_id, proposal_id: a.proposal_id, requirements_sha256: a.requirements_sha256, ...(a.implementation_sha256 ? { implementation_sha256: a.implementation_sha256 } : {}) } : {};
  };
  const handoff = async (extra = {}) => {
    const s = await start('implementation');
    return call('handoff', { phase: 'implementation', input: await input({ phase_token: s.phase_token, ...extra }) });
  };
  const submit = async (phase, token, data = {}) => call('complete', { phase, input: await input({
    phase_token: token, summary: `${phase} findings`, artifacts: [await artifact(`${phase}.md`)],
    ...(['implementation', 'verification'].includes(phase) ? { ...await binding(), parent_review: 'Reviewed fixture changes and test evidence against AC1', repository_review: 'Reviewed baseline and resulting changes; fixture has no unrelated edits' } : {}),
    ...data,
  }) });
  const step = async (phase, data) => submit(phase, (await start(phase)).phase_token, data);
  const evidence = exceptions => step('evidence_review', { attachments: [], no_video_reason: 'Ticket has no video attachments', exceptions: exceptions ?? [] });
  const investigation = (extra = {}) => step('investigation', { current_behavior: 'Feature currently absent', relevant_files: ['app.js'], feature_analysis: 'Enable behavior using existing module', constraints: [], ...(kind !== 'feature' ? { reproduction: { status: 'reproduced', environment: 'local fixture', steps: ['Run example'], expected: 'Enabled', actual: 'Disabled' } } : {}), ...extra });
  const present = async (extra = {}) => {
    const phase_token = (await start('clarification')).phase_token;
    const report = { phase_token, summary: 'Enable the behavior for all roles', artifacts: [await artifact('clarification.md')],
      acceptance_criteria: [{ id: 'AC1', requirement: 'Behavior is enabled', verification: 'Inspect result' }],
      scope_exclusions: [], questions: [], ...extra };
    const status = await call('present', { phase: 'clarification', input: await input(report) });
    return { report, status };
  };
  const approve = async ({ report, status }, alignment = {}) => call('complete', { phase: 'clarification', input: await input({
    ...report, alignment: { status: 'confirmed_by_user', rationale: 'User approved this presented summary',
      user_response: 'User: I approve this summary; proceed.', proposal_id: status.proposal.id, ...alignment },
  }) });
  const clarification = async (extra = {}) => approve(await present(extra));
  const implementation = async () => {
    const s = await start('implementation');
    if (!s.assignment) await handoff();
    await writeFile(join(repo, 'app.js'), 'export const enabled = true;\n');
    return submit('implementation', s.phase_token, { addressed_criteria: ['AC1'], changed_files: ['app.js'] });
  };
  const verification = async (extra = {}) => {
    const state = await start('verification');
    const result = await verify('APP-1', { out, phase: 'verification', binding: state.assignment.binding_path }, [process.execPath, '-e', 'console.log("PASS")']);
    return submit('verification', state.phase_token, {
      criteria: [{ id: 'AC1', status: 'passed', result: 'Behavior enabled', evidence: [result.log] }],
      checks: [{ command: 'fixture-check', exit_code: 0, evidence: result.log }], verification_receipts: [result.receipt],
      ...(kind !== 'feature' ? { reproduction_recheck: { status: 'passed', result: 'Original steps now pass' } } : {}), ...extra,
    });
  };
  return { root, out, repo, manifest, call, input, artifact, start, submit, step, binding, handoff, evidence, investigation, present, approve, clarification, implementation, verification };
}

test('feature workflow enforces order, acceptance criteria, and proof; then reaches completion', async t => {
  const f = await fixture(t);
  await assert.rejects(f.start('implementation'), /Earlier required phases/);
  await f.evidence(); await f.investigation();
  const s = await f.start('clarification');
  await assert.rejects(f.submit('clarification', s.phase_token, { acceptance_criteria: [] }), /Acceptance criteria/);
  await f.clarification();
  await assert.rejects(f.call('assert', { phase: 'implementation' }), /Start the phase/);
  await f.implementation();
  const vs = await f.start('verification');
  await assert.rejects(f.submit('verification', vs.phase_token, { criteria: [{ id: 'AC1', status: 'failed' }], checks: [] }), /not passed/);
  const done = await f.verification();
  assert.equal(done.done, true); assert.equal(done.outcome, 'complete');
  const progress = await json(join(f.out, 'progress.json'));
  assert.deepEqual(progress.events.filter(e => e.action === 'complete').map(e => e.phase), ['evidence_review', 'investigation', 'clarification', 'implementation', 'verification']);
});

test('bugs cannot skip reproduction and mixed requests also require feature analysis', async t => {
  const f = await fixture(t, { kind: 'mixed' }); await f.evidence();
  const s = await f.start('investigation');
  await assert.rejects(f.submit('investigation', s.phase_token, { current_behavior: 'broken', relevant_files: [] }), /require reproduction/);
  await assert.rejects(f.investigation({ feature_analysis: '' }), /feature_analysis/);
  await f.investigation(); await f.clarification(); await f.implementation();
  const v = await f.start('verification');
  await assert.rejects(f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'Cannot rerun' } }), /requires a passing/);
  assert.ok(v.phase_token); assert.equal((await f.verification()).done, true);
});

test('review-only and clarify-only scopes cannot reach implementation', async t => {
  const review = await fixture(t, { scope: 'review' });
  await review.evidence(); const done = await review.investigation();
  assert.equal(done.done, true); assert.equal(done.phases.implementation, 'not_applicable_to_scope');
  await assert.rejects(review.start('implementation'), /outside.*scope/);
  const clarify = await fixture(t, { scope: 'clarify' });
  await clarify.evidence(); await clarify.investigation();
  assert.equal((await clarify.clarification()).done, true);
  await assert.rejects(clarify.start('implementation'), /outside.*scope/);
});

test('material unanswered questions and requested sign-off block implementation until actual responses are recorded', async t => {
  const f = await fixture(t);
  await f.evidence(); await f.investigation(); await f.start('clarification');
  await f.call('block', { phase: 'clarification', input: await f.input({ reason: 'Need decision', questions: [{ id: 'Q1', question: 'Enable for all roles?', material: true }] }) });
  const continued = await session('continue', 'APP-1', { out: f.out }, { env: {} });
  assert.equal(continued.phases.clarification, 'blocked');
  await f.call('invalidate', { phase: 'clarification', reason: 'Reconsidering the scope' });
  await assert.rejects(f.clarification(), /Q1 must be answered/);
  const answers = [{ id: 'Q1', answer: 'Yes', source: 'user', user_response: 'User: enable for all roles.' }];
  const proposal = await f.present({ resolved_questions: answers });
  await assert.rejects(f.approve(proposal, { status: 'clear_from_existing_instructions' }), /Explicit user approval/);
  await f.approve(proposal);
  assert.equal((await f.start('implementation')).next_phase, 'implementation');
});

test('partial evidence and unreproduced bugs require explicit exceptions and clarification decisions', async t => {
  const f = await fixture(t, { kind: 'bug', partial: true });
  await assert.rejects(f.evidence(), /missing_evidence exception/);
  await f.evidence([{ code: 'missing_evidence', reason: 'Comments endpoint is unavailable' }]);
  const reproduction = { status: 'not_reproduced', environment: 'Local test instance', steps: ['Run original steps'], expected: 'Enabled', actual: 'Already enabled', reason: 'Different data' };
  await assert.rejects(f.investigation({ reproduction }), /not_reproduced exception/);
  await f.investigation({ reproduction, exceptions: [{ code: 'not_reproduced', reason: 'Missing production-specific fixture' }] });
  await assert.rejects(f.clarification(), /Resolve evidence_review/);
  await f.clarification({ exception_decisions: [
    { phase: 'evidence_review', code: 'missing_evidence', resolution: 'not_material', reason: 'Description contains the complete requested change' },
    { phase: 'investigation', code: 'not_reproduced', resolution: 'accepted_by_user', reason: 'User wants defensive fix verified by a regression test', user_response: 'Proceed with the regression test.' },
  ] });
  assert.equal((await f.start('implementation')).next_phase, 'implementation');
});

test('changed ticket evidence invalidates later phases and rejects in-flight stale results', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const running = await f.start('implementation');
  f.manifest.snapshot_sha256 = 'snapshot-two';
  await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest));
  await assert.rejects(f.submit('implementation', running.phase_token, { addressed_criteria: ['AC1'], changed_files: ['app.js'] }), /Earlier required phases/);
  const status = await f.call('status');
  assert.equal(status.next_phase, 'evidence_review');
  assert.equal(status.phases.clarification, 'pending');
  const state = await json(join(f.out, 'progress.json'));
  assert.equal(state.reconciled_snapshot, null);
  assert.ok(state.events.some(e => e.action === 'invalidate' && e.reason.includes('evidence availability')));
});

test('revised requirement artifacts and changed implementation files invalidate dependent work', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification(); await f.implementation();
  let p = await json(join(f.out, 'progress.json'));
  await writeFile(join(p.artifact_directory, 'clarification.md'), 'Changed requirements');
  assert.equal((await f.call('status')).next_phase, 'clarification');
  await f.clarification(); await f.implementation();
  await writeFile(join(f.repo, 'app.js'), 'export const enabled = false;\n');
  assert.equal((await f.call('status')).next_phase, 'implementation');
  await f.implementation(); await f.verification();
  const invalidated = await f.call('invalidate', { phase: 'clarification', reason: 'User changed the empty-state requirement' });
  assert.equal(invalidated.done, false); assert.equal(invalidated.next_phase, 'clarification');
});

test('interrupted phases retain their token; reset preserves scope but requires a fresh workflow', async t => {
  const f = await fixture(t, { scope: 'review' });
  const s = await f.start('evidence_review');
  const continued = await session('continue', 'APP-1', { out: f.out }, { env: {} });
  assert.equal(continued.phase_token, s.phase_token);
  assert.equal((await f.start('evidence_review')).phase_token, s.phase_token);
  await f.evidence(); await f.investigation();
  const reset = await session('reset', 'APP-1', { out: f.out }, { env: {} });
  assert.equal(reset.done, false); assert.equal(reset.next_phase, 'evidence_review');
  const p = await json(join(f.out, 'progress.json'));
  assert.equal(p.config.scope, 'review'); assert.equal(p.reconciled_snapshot, null);
  await assert.rejects(f.submit('evidence_review', s.phase_token, { attachments: [], no_video_reason: 'None' }), /Start or resume/);
});

test('artifacts outside the work directory and outside-repository code paths are rejected', async t => {
  const f = await fixture(t); const s = await f.start('evidence_review');
  const outside = join(f.root, 'outside.md'); await writeFile(outside, 'Not workflow evidence');
  const link = await f.artifact('link.md'); await rm(link); await symlink(outside, link);
  await assert.rejects(f.submit('evidence_review', s.phase_token, { artifacts: [link], attachments: [], no_video_reason: 'None' }), /inside the ticket/);
  await f.evidence(); await f.investigation(); await f.clarification();
  const implementation = await f.start('implementation');
  await assert.rejects(f.submit('implementation', implementation.phase_token, { addressed_criteria: ['AC1'], changed_files: ['../outside.md'] }), /inside the configured repository/);
});

test('legacy sessions are archived and require validated phases rather than trusting old complete flags', async t => {
  const f = await fixture(t);
  const old = await json(join(f.out, 'progress.json')); old.version = 3; old.phases.implementation.status = 'complete';
  await writeFile(join(f.out, 'progress.json'), JSON.stringify(old));
  const status = await f.call('status');
  assert.equal(status.scope, null); assert.equal(status.phases.implementation, 'pending');
  assert.match(status.next_action, /Configure/);
  const migrated = await json(join(f.out, 'progress.json'));
  assert.equal(migrated.events[0].action, 'migrate');
  assert.equal((await json(migrated.events[0].archive)).progress.version, 3);
});

test('video review requires every attachment, inspected overview sheets and valid timestamped observations', async t => {
  const f = await fixture(t), videoDir = join(f.out, 'evidence'); await mkdir(videoDir);
  const sheet = join(videoDir, 'contact-001.jpg'); await writeFile(sheet, 'fixture image bytes');
  const videoManifest = join(videoDir, 'manifest.json');
  await writeFile(videoManifest, JSON.stringify({ duration_seconds: 4, contact_sheets: ['contact-001.jpg'] }));
  f.manifest.attachments = [{ id: '42', status: 'downloaded', sha256: 'source-hash', is_video: true, video: { status: 'prepared', directory: videoDir, manifest: videoManifest } }];
  await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest));
  const s = await f.start('evidence_review');
  await assert.rejects(f.submit('evidence_review', s.phase_token, { attachments: [] }), /every attachment/);
  await assert.rejects(f.submit('evidence_review', s.phase_token, { attachments: [{ id: '42', disposition: 'not_relevant', reason: 'Exclude the recording' }] }), /missing_evidence exception/);
  await assert.rejects(f.submit('evidence_review', s.phase_token, { attachments: [{ id: '42', disposition: 'reviewed', inspected_files: [], observations: [] }] }), /every overview/);
  await assert.rejects(f.submit('evidence_review', s.phase_token, { attachments: [{ id: '42', disposition: 'reviewed', inspected_files: [sheet], observations: [{ timestamp_seconds: 5, observation: 'Too late' }] }] }), /outside the video/);
  await f.submit('evidence_review', s.phase_token, { attachments: [{ id: '42', disposition: 'reviewed', inspected_files: [sheet], observations: [{ timestamp_seconds: 2, observation: 'Dialog visible' }] }] });
  await rm(sheet);
  assert.equal((await f.call('status')).next_phase, 'evidence_review');
});

test('bare invocation requires approval of the exact presented proposal and cannot disable the gate', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('configure', { input: await f.input({ kind: 'feature', scope: 'implement', repository: f.repo, user_request: 'Implement APP-1', requires_user_confirmation: false }) }), /cannot be disabled/);
  await f.evidence(); await f.investigation();
  const draft = await f.present();
  await assert.rejects(f.start('implementation'), /Earlier required phases/);
  await assert.rejects(f.approve(draft, { user_response: '' }), /user_response/);
  const resumed = await session('continue', 'APP-1', { out: f.out }, { env: {} });
  assert.equal(resumed.proposal.id, draft.status.proposal.id);
  await assert.rejects(f.approve({ ...draft, report: { ...draft.report, summary: 'A different scope' } }), /Requirements changed/);
  const revised = await f.present({ summary: 'A revised scope' });
  await assert.rejects(f.approve(revised, { proposal_id: draft.status.proposal.id }), /current proposal_id/);
  await f.approve(revised);
  assert.equal((await f.start('implementation')).next_phase, 'implementation');
});

test('unpresented reports, edited pending proposals and reset cannot reuse approval', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation();
  const draft = await f.present();
  await f.call('invalidate', { phase: 'clarification', reason: 'User requested grooming' });
  const fresh = await f.start('clarification');
  await assert.rejects(f.approve({ ...draft, report: { ...draft.report, phase_token: fresh.phase_token } }), /Present the requirements/);
  const second = await f.present();
  await writeFile(second.status.proposal.path, '{}');
  assert.equal((await f.call('status')).phases.clarification, 'pending');
  await assert.rejects(f.approve(second), /Start or resume/);
  const third = await f.present();
  await session('reset', 'APP-1', { out: f.out }, { env: {} });
  await assert.rejects(f.approve(third), /Earlier required phases/);
});

test('version 4 approval bypass states are archived instead of trusted', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const old = await json(join(f.out, 'progress.json')); old.version = 4;
  await writeFile(join(f.out, 'progress.json'), JSON.stringify(old));
  const status = await f.call('status');
  assert.equal(status.phases.clarification, 'pending');
  await assert.rejects(f.start('implementation'), /Configure/);
});

test('handoff carries approved requirements and references without raw evidence, and is exclusive', async t => {
  const f = await fixture(t, { kind: 'mixed' });
  await assert.rejects(f.handoff(), /Earlier required phases/);
  await f.evidence(); await f.investigation(); await f.clarification();
  const running = await f.start('implementation');
  await assert.rejects(f.call('assert', { phase: 'implementation' }), /handoff/);
  await assert.rejects(f.submit('implementation', running.phase_token, { addressed_criteria: ['AC1'], changed_files: ['app.js'] }), /handoff/);
  const assigned = await f.handoff();
  const packet = await json(assigned.assignment.path);
  assert.equal(packet.repository, await realpath(f.repo));
  assert.equal(packet.requirements.acceptance_criteria[0].id, 'AC1');
  assert.equal(packet.investigation.reproduction.status, 'reproduced');
  assert.equal(packet.references.clarification.result, (await json(join(f.out, 'progress.json'))).phases.clarification.result_file);
  assert.ok(!('attachments' in packet));
  await assert.rejects(f.handoff(), /already exists/);
  await f.call('check-worker', { phase: 'implementation', input: assigned.assignment.binding_path });
  await f.call('assert', { phase: 'implementation' });
  assert.equal((await session('continue', 'APP-1', { out: f.out }, { env: {} })).assignment.assignment_id, assigned.assignment.assignment_id);
});

test('interrupted workers are replaced explicitly and old bindings cannot submit results', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const first = await f.handoff(), old = await f.binding();
  await f.call('block', { phase: 'implementation', reason: 'Worker stopped after interruption; inspect existing diff' });
  await assert.rejects(f.call('check-worker', { phase: 'implementation', input: first.assignment.binding_path }), /active implementation/);
  const second = await f.handoff();
  assert.notEqual(first.assignment.assignment_id, second.assignment.assignment_id);
  await assert.rejects(f.submit('implementation', second.phase_token, { addressed_criteria: ['AC1'], changed_files: ['app.js'], ...old }), /Stale or missing worker binding/);
  await f.implementation();
  await assert.rejects(f.verification({ ...old }), /Stale or missing worker binding/);
  await assert.rejects(f.verification({ parent_review: '' }), /parent_review/);
  await f.verification();
});

test('unavailable subagents require a recorded fallback reason with the same result validation', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  await assert.rejects(f.handoff({ mode: 'main_agent' }), /requires a reason/);
  const s = await f.handoff({ mode: 'main_agent', reason: 'Host has no subagent tool' });
  assert.equal(s.assignment.mode, 'main_agent');
  await f.implementation(); assert.equal((await f.verification()).done, true);
});

test('changed handoffs or approved scope revoke worker bindings', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const s = await f.handoff();
  await writeFile(s.assignment.path, '{}');
  await assert.rejects(f.call('check-worker', { phase: 'implementation', input: s.assignment.binding_path }), /active implementation/);
  assert.equal((await f.call('status')).assignment, null);
  const next = await f.handoff();
  await f.call('invalidate', { phase: 'clarification', reason: 'User changed the scope' });
  await assert.rejects(f.call('check-worker', { phase: 'implementation', input: next.assignment.binding_path }), /Earlier required phases/);
  await f.clarification({ summary: 'Revised and approved scope' });
  const replacement = await f.handoff();
  await assert.rejects(f.call('check-worker', { phase: 'implementation', input: next.assignment.binding_path }), /Stale or missing worker binding/);
  assert.notEqual(replacement.assignment.requirements_sha256, next.assignment.requirements_sha256);
});

test('schema 5 upgrades preserve approval but reopen implementation for a handoff', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification(); await f.implementation();
  const p = await json(join(f.out, 'progress.json')), approved = p.phases.clarification.result_sha256;
  p.version = 5;
  await writeFile(join(f.out, 'progress.json'), JSON.stringify(p));
  const status = await f.call('status');
  assert.equal(status.next_phase, 'implementation'); assert.equal(status.assignment, null);
  assert.equal((await json(join(f.out, 'progress.json'))).phases.clarification.result_sha256, approved);
  await f.handoff();
});

test('blocker answers are validated before assignment and delivered to the replacement worker', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification(); await f.handoff();
  await f.call('block', { phase: 'implementation', input: await f.input({ reason: 'Need fixture access', questions: [{ id: 'Q9', question: 'Which local fixture?', material: true }] }) });
  await assert.rejects(f.handoff(), /Q9 must be answered/);
  const answers = [{ id: 'Q9', answer: 'Fixture A', source: 'user', user_response: 'Use fixture A' }];
  await assert.rejects(f.handoff({ resolved_questions: [{ ...answers[0], source: 'agent' }] }), /actual user response/);
  const assigned = await f.handoff({ resolved_questions: answers });
  const packet = await json(assigned.assignment.path);
  assert.deepEqual(packet.resolved_questions, answers);
  assert.equal(packet.binding_path, assigned.assignment.binding_path);
  assert.ok(packet.skill_directory.endsWith('ticket-to-implementation/'));
  assert.ok(packet.check_worker.args.includes(assigned.assignment.binding_path));
  await f.submit('implementation', assigned.phase_token, { resolved_questions: packet.resolved_questions, addressed_criteria: ['AC1'], changed_files: ['app.js'] });
});

test('verification replacement revokes old workers and preserves accepted implementation', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification(); await f.implementation();
  const old = await f.binding(), oldPath = (await f.call('status')).assignment.binding_path;
  const before = (await json(join(f.out, 'progress.json'))).phases.implementation.result_sha256;
  await f.start('verification');
  await f.call('block', { phase: 'verification', reason: 'Verification worker lost; stopped before replacement' });
  const resumed = await f.start('verification');
  await assert.rejects(f.call('check-worker', { phase: 'verification', input: oldPath }), /handoff/);
  const assigned = await f.call('handoff', { phase: 'verification', input: await f.input({ phase_token: resumed.phase_token }) });
  assert.equal(assigned.assignment.implementation_sha256, before);
  assert.equal((await json(assigned.assignment.path)).phase, 'verification');
  await assert.rejects(f.verification(old), /Stale or missing worker binding/);
  await f.call('check-worker', { phase: 'verification', input: assigned.assignment.binding_path });
  assert.equal((await f.verification()).done, true);
  assert.equal((await json(join(f.out, 'progress.json'))).phases.implementation.result_sha256, before);
});

test('workflow lock contention retries without revoking the worker and has a distinct busy error', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification(); const a = await f.handoff();
  const release = await acquireLock(f.out);
  const pending = f.call('check-worker', { phase: 'implementation', input: a.assignment.binding_path });
  await new Promise(resolve => setTimeout(resolve, 150));
  await release();
  assert.equal((await pending).assignment.assignment_id, a.assignment.assignment_id);
  const held = await acquireLock(f.out);
  try { await assert.rejects(acquireLock(f.out, { timeoutMs: 30 }), e => e.code === 'LOCK_BUSY'); }
  finally { await held(); }
});

test('future schemas are refused unchanged and legacy reset drops unvalidated configuration', async t => {
  const f = await fixture(t), path = join(f.out, 'progress.json');
  const p = await json(path); p.version = 7; await writeFile(path, JSON.stringify(p));
  const before = await readFile(path, 'utf8');
  await assert.rejects(f.call('status'), /newer schema/);
  await assert.rejects(session('reset', 'APP-1', { out: f.out }, { env: {} }), /newer schema/);
  assert.equal(await readFile(path, 'utf8'), before);
  p.version = 4; p.config.repository = '/does-not-exist'; p.config.requires_user_confirmation = false;
  await writeFile(path, JSON.stringify(p));
  await session('reset', 'APP-1', { out: f.out }, { env: {} });
  assert.equal((await json(path)).config, null);
});

test('missing legacy approval bindings reopen clarification and missing binding values never match', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const path = join(f.out, 'progress.json'), p = await json(path);
  const result = await json(p.phases.clarification.result_file);
  delete result.alignment.proposal_id;
  await writeFile(p.phases.clarification.result_file, JSON.stringify(result));
  p.phases.clarification.result_sha256 = await hashFile(p.phases.clarification.result_file);
  p.version = 5; await writeFile(path, JSON.stringify(p));
  assert.equal((await f.call('status')).next_phase, 'clarification');
  assert.throws(() => validateBinding({ phases: { implementation: { assignment: {} } } }, {}), /missing worker binding/);
});

test('deleted paths cannot escape the repository via a symlinked ancestor', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const assigned = await f.handoff();
  await symlink(f.out, join(f.repo, 'external'));
  await assert.rejects(f.submit('implementation', assigned.phase_token, { addressed_criteria: ['AC1'], changed_files: ['external/missing/deleted.js'] }), /parent escapes/);
  await rm(join(f.repo, 'external'));
  await f.submit('implementation', assigned.phase_token, { addressed_criteria: ['AC1'], changed_files: ['missing/deleted.js'] });
});

test('verification rejects code changes during checks and stale pre-implementation receipts', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const assignment = await f.handoff();
  await assert.rejects(verify('APP-1', { out: f.out, binding: assignment.assignment.binding_path }, [process.execPath, '-e', 'require("fs").writeFileSync("app.js","changed during test")']), /Code changed/);
  const old = await verify('APP-1', { out: f.out, binding: assignment.assignment.binding_path }, [process.execPath, '-e', 'console.log("old code passed")']);
  await f.implementation();
  const s = await f.start('verification');
  await assert.rejects(f.submit('verification', s.phase_token, {
    criteria: [{ id: 'AC1', status: 'passed', result: 'Old result', evidence: [old.log] }],
    checks: [{ command: 'old check', exit_code: 0, evidence: old.log }], verification_receipts: [old.receipt],
  }), /stale or unregistered/);
  await f.verification();
  await writeFile(join(f.repo, 'other.js'), 'unreported concurrent change');
  assert.equal((await f.call('status')).next_phase, 'implementation');
});

test('implementation rejects unreported files and changed Git branch', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const assignment = await f.handoff();
  await writeFile(join(f.repo, 'unexpected.js'), 'unreported');
  await assert.rejects(f.submit('implementation', assignment.phase_token, { addressed_criteria: ['AC1'], changed_files: ['app.js'] }), /Unreported repository changes/);
});

test('manual inspection receipts bind the observed interval and failing commands cannot register', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const a = await f.handoff(), options = { out: f.out, binding: a.assignment.binding_path };
  const failed = await verify('APP-1', options, [process.execPath, '-e', 'console.error("diagnostic"); process.exit(1)']);
  assert.equal(failed.exit_code, 1);
  assert.match(await readFile(failed.log, 'utf8'), /diagnostic/);
  assert.equal((await json(failed.receipt)).exit_code, 1);
  assert.ok(!(await f.call('status')).assignment.checks?.length);
  const report = await f.artifact('manual.md', 'Inspected fixture behavior against AC1.');
  const first = await verify('APP-1', { ...options, manualStart: true }, []);
  await writeFile(join(f.repo, 'app.js'), 'changed');
  await assert.rejects(verify('APP-1', { ...options, manualFinish: first.checkpoint, report }, []), /Code changed/);
  const next = await verify('APP-1', { ...options, manualStart: true }, []);
  const result = await verify('APP-1', { ...options, manualFinish: next.checkpoint, report }, []);
  assert.equal(result.exit_code, 0);
  assert.ok(result.receipt);
});

test('configure rejects repositories equal to or nested in ticket work directory', async t => {
  const f = await fixture(t);
  const repo = join(f.out, 'repo'); await mkdir(repo);
  for (const repository of [f.out, repo]) await assert.rejects(f.call('configure', { input: await f.input({ kind: 'feature', scope: 'implement', user_request: 'Do work', repository }) }), /inside the ticket work directory/);
});

test('manual checkpoints reject wrong types, missing reports and reuse', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const a = await f.handoff(), options = { out: f.out, binding: a.assignment.binding_path };
  const report = await f.artifact('observations.md', 'Inspected AC1.');
  await assert.rejects(verify('APP-1', { ...options, manualFinish: a.assignment.binding_path, report }, []), /Invalid manual-start/);
  const start = await verify('APP-1', { ...options, manualStart: true }, []);
  await assert.rejects(verify('APP-1', { ...options, manualFinish: start.checkpoint }, []), /requires --report/);
  await verify('APP-1', { ...options, manualFinish: start.checkpoint, report }, []);
  await assert.rejects(verify('APP-1', { ...options, manualFinish: start.checkpoint, report }, []), /already consumed/);
});

test('re-blocking an identical question is idempotent but conflicting IDs still fail', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation();
  const data = { reason: 'Need a decision', questions: [{ id: 'Q1', question: 'Which role?', material: true }] };
  await f.start('clarification');
  await f.call('block', { phase: 'clarification', input: await f.input(data) });
  await f.start('clarification');
  await f.call('block', { phase: 'clarification', input: await f.input(data) });
  assert.equal((await f.call('status')).questions.length, 1);
  await f.start('clarification');
  await assert.rejects(f.call('block', { phase: 'clarification', input: await f.input({ ...data, questions: [{ ...data.questions[0], question: 'Different question' }] }) }), /unique/);
});

test('staging and committing completed code preserves completion; edits still reopen it', async t => {
  const f = await fixture(t);
  const git = args => execFileSync('git', ['-C', f.repo, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']);
  const commit = () => git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  commit();
  await f.evidence(); await f.investigation(); await f.clarification(); await f.implementation(); await f.verification();
  git(['add', '.']); assert.equal((await f.call('status')).done, true);
  commit(); assert.equal((await f.call('status')).done, true);
  await writeFile(join(f.repo, 'app.js'), 'changed after commit');
  assert.equal((await f.call('status')).next_phase, 'implementation');
});

test('failed verification CLI prints its log and receipt paths with nonzero exit', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const a = await f.handoff();
  try {
    execFileSync(process.execPath, [new URL('../scripts/verify.mjs', import.meta.url).pathname, 'APP-1', '--out', f.out, '--binding', a.assignment.binding_path, '--timeout', '2', '--', process.execPath, '-e', 'console.error("failure detail");process.exit(9)'], { stdio: 'pipe' });
    assert.fail('CLI should exit nonzero');
  } catch (error) {
    assert.equal(error.status, 1);
    const result = JSON.parse(error.stdout.toString());
    assert.equal(result.exit_code, 9);
    assert.match(await readFile(result.log, 'utf8'), /failure detail/);
    assert.equal((await json(result.receipt)).exit_code, 9);
  }
});

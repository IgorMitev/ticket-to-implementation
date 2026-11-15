import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, link, copyFile, utimes } from 'node:fs/promises';
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
  const investigationData = async (extra = {}) => ({
    current_behavior: 'Feature currently absent', relevant_files: ['app.js'], feature_analysis: 'Enable behavior using existing module', constraints: [],
    ...(kind !== 'feature' ? { reproduction: { status: 'reproduced', attempted_locally: true, environment: 'local fixture', target: 'local fixture process', steps: ['Run example'], expected: 'Enabled', actual: 'Disabled', evidence: [await artifact('local-repro.log', 'Local fixture run: expected enabled, observed disabled')] } } : {}), ...extra,
  });
  const investigation = async (extra = {}) => step('investigation', await investigationData(extra));
  const requestWaiver = async (extra = {}) => {
    const phase_token = (await start('investigation')).phase_token;
    const report = { phase_token, summary: 'Investigation findings and reproduction limitation', artifacts: [await artifact('investigation.md')], ...await investigationData(extra) };
    const status = await call('request-reproduction-waiver', { phase: 'investigation', input: await input(report) });
    return { report, status };
  };
  const approveWaiver = async (request, overrides = {}) => {
    const phase_token = (await start('investigation')).phase_token;
    return call('complete', { phase: 'investigation', input: await input({
      ...request.report, phase_token, reproduction_waiver: {
        decision: 'approved', scope: 'proceed_without_local_reproduction',
        request_id: request.status.reproduction_request.id,
        user_response: 'User: I approve proceeding without local reproduction for this limitation.',
        ...overrides,
      },
    }) });
  };
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
  return { root, out, repo, manifest, call, input, artifact, start, submit, step, binding, handoff, evidence, investigation, requestWaiver, approveWaiver, present, approve, clarification, implementation, verification };
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
  const reproduction = { status: 'not_reproduced', attempted_locally: true, target: 'local fixture process', evidence: [await f.artifact('attempt.log', 'Local attempt did not show reported bug')], alternative_verification: 'Regression test with recorded fixture data', environment: 'Local test instance', steps: ['Run original steps'], expected: 'Enabled', actual: 'Already enabled', reason: 'Different data' };
  await assert.rejects(f.investigation({ reproduction }), /not_reproduced exception/);
  await assert.rejects(f.investigation({ reproduction, exceptions: [{ code: 'not_reproduced', reason: 'Missing production-specific fixture' }] }), /explicit user waiver/);
  const waiver = await f.requestWaiver({ reproduction, exceptions: [{ code: 'not_reproduced', reason: 'Missing production-specific fixture' }] });
  await f.approveWaiver(waiver);
  await assert.rejects(f.clarification(), /Resolve evidence_review/);
  await f.clarification({ reproduction_waiver_id: waiver.status.reproduction_request.id, exception_decisions: [
    { phase: 'evidence_review', code: 'missing_evidence', resolution: 'not_material', reason: 'Description contains the complete requested change' },
    { phase: 'investigation', code: 'not_reproduced', resolution: 'accepted_by_user', reason: 'User wants defensive fix verified by a regression test', waiver_request_id: waiver.status.reproduction_request.id, user_response: 'User: I approve proceeding without local reproduction for this limitation.' },
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
  const p = await json(path); p.version = 8; await writeFile(path, JSON.stringify(p));
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

async function omission(f, status = 'blocked') {
  return {
    reproduction: { status, attempted_locally: status !== 'blocked', environment: 'Local dev server with QA backend',
      target: 'http://localhost:4200/live', steps: status === 'blocked' ? ['Inspected local setup and existing services; QA credentials unavailable'] : ['Opened the local app', 'Ran the reported tennis sequence'],
      expected: 'Correct league count', actual: status === 'blocked' ? 'Runtime attempt unavailable' : 'Count did not spike during local attempt',
      reason: 'Required transient QA data unavailable', alternative_verification: 'Regression test with fixture counts, followed by local recheck when access returns',
      evidence: [await f.artifact('repro-attempt.md', 'Observed setup or runtime result with exact local target and missing data')],
    },
    exceptions: [{ code: 'not_reproduced', reason: 'Local reproduction not established' }],
  };
}

for (const kind of ['bug', 'mixed']) {
  test(kind + ' investigation requires local evidence or a separately requested user waiver', async t => {
    const f = await fixture(t, { kind }); await f.evidence();
    const data = await omission(f);
    await assert.rejects(f.investigation(data), /explicit user waiver/);
    await assert.rejects(f.investigation({ reproduction: { ...data.reproduction, status: 'reproduced' } }), /actual local runtime attempt/);
    await assert.rejects(f.investigation({ reproduction: { ...data.reproduction, status: 'reproduced', attempted_locally: true, evidence: [] } }), /concrete evidence/);
    const requested = await f.requestWaiver(data);
    assert.equal(requested.status.phases.investigation, 'blocked');
    await assert.rejects(f.start('clarification'), /Earlier required phases/);
    await assert.rejects(f.start('implementation'), /Earlier required phases/);
    const resumed = await session('continue', 'APP-1', { out: f.out }, { env: {} });
    assert.equal(resumed.reproduction_request.id, requested.status.reproduction_request.id);
    await assert.rejects(f.approveWaiver(requested, { scope: 'implement_ticket' }), /explicitly approve proceeding/);
    await assert.rejects(f.approveWaiver(requested, { user_response: '' }), /user_response/);
    await assert.rejects(f.approveWaiver(requested, { decision: 'denied' }), /explicitly approve proceeding/);
    await f.approveWaiver(requested);
    const id = requested.status.reproduction_request.id;
    const response = 'User: I approve proceeding without local reproduction for this limitation.';
    await assert.rejects(f.clarification({ reproduction_waiver_id: id, exception_decisions: [{ phase: 'investigation', code: 'not_reproduced', resolution: 'not_material', reason: 'Transient data' }] }), /cannot be marked/);
    await assert.rejects(f.clarification({ reproduction_waiver_id: id, exception_decisions: [{ phase: 'investigation', code: 'not_reproduced', resolution: 'resolved', reason: 'Static inspection is enough', evidence: data.reproduction.evidence }] }), /cannot be marked/);
    const decision = { phase: 'investigation', code: 'not_reproduced', resolution: 'accepted_by_user', reason: 'Specific omission approved', waiver_request_id: id, user_response: response };
    await assert.rejects(f.clarification({ exception_decisions: [decision] }), /summary must explicitly reference/);
    await f.clarification({ reproduction_waiver_id: id, exception_decisions: [decision] });
    const h = await f.handoff();
    const packet = await json(h.assignment.path);
    assert.equal(packet.investigation.reproduction_waiver.request_id, id);
    assert.equal(packet.investigation.reproduction.attempted_locally, false);
    await f.implementation();
    await assert.rejects(f.verification({ reproduction_recheck: undefined }), /reproduction_recheck/);
    await assert.rejects(f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'skipped' }, exceptions: [{ code: 'runtime_unverified', reason: 'Agent skipped runtime checks' }] }), /exact user-approved/);
    await assert.rejects(f.verification({ reproduction_recheck: { status: 'passed', result: 'skipped' } }), /exact user-approved/);
    const alternative = { plan: data.reproduction.alternative_verification, performed: 'Ran the agreed count regression with fixture data; local recheck remains conditional on access returning', evidence: [await f.artifact('post-fix-alternative.md', 'Post-fix fixture regression result and remaining runtime limitation')] };
    await assert.rejects(f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'Regression passed', alternative_verification: { ...alternative, plan: 'Different test plan' } } }), /exact user-approved/);
    await assert.rejects(f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'Regression passed', alternative_verification: { ...alternative, evidence: [] } } }), /concrete post-fix/);
    const progress = await json(join(f.out, 'progress.json'));
    for (const stale of [data.reproduction.evidence[0], requested.status.reproduction_request.path, progress.phases.investigation.result_file]) {
      await assert.rejects(f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'Regression passed', alternative_verification: { ...alternative, evidence: [stale] } }, exceptions: [{ code: 'runtime_unverified', reason: 'Original environment still unavailable' }] }), /recorded by earlier steps/);
    }
    const old = await f.artifact('pre-fix-notes.md', 'Notes written before the fix');
    await utimes(old, new Date(Date.parse(progress.phases.implementation.completed_at) - 60000), new Date(Date.parse(progress.phases.implementation.completed_at) - 60000));
    await assert.rejects(f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'Regression passed', alternative_verification: { ...alternative, evidence: [old] } }, exceptions: [{ code: 'runtime_unverified', reason: 'Original environment still unavailable' }] }), /after implementation completed/);
    const rerun = await f.artifact('post-fix-rerun.md', await readFile(data.reproduction.evidence[0]));
    const done = await f.verification({ reproduction_recheck: { status: 'not_reproduced', result: 'Runtime remains unavailable; agreed regression tests passed', alternative_verification: { ...alternative, evidence: [...alternative.evidence, rerun] } }, exceptions: [{ code: 'runtime_unverified', reason: 'Original environment still unavailable' }] });
    assert.equal(done.outcome, 'complete_with_exceptions');
  });
}

test('unsuccessful local attempts still need permission to proceed, tied to exact limitation', async t => {
  const f = await fixture(t, { kind: 'bug' }); await f.evidence();
  const data = await omission(f, 'not_reproduced');
  await assert.rejects(f.investigation(data), /explicit user waiver/);
  const first = await f.requestWaiver(data);
  await assert.rejects(f.approveWaiver({ ...first, report: { ...first.report, reproduction: { ...first.report.reproduction, reason: 'Different environment and limitation' } } }), /circumstances changed/);
  await f.call('invalidate', { phase: 'investigation', reason: 'Access conditions changed; reassess reproduction' });
  const second = await f.requestWaiver(data);
  await assert.rejects(f.approveWaiver(second, { request_id: first.status.reproduction_request.id }), /Stale or missing/);
  await f.approveWaiver(second);
});

test('changed evidence, ticket refresh, block and reset revoke pending reproduction waivers', async t => {
  for (const event of ['evidence', 'ticket', 'block', 'reset']) {
    const f = await fixture(t, { kind: 'bug' }); await f.evidence();
    const data = await omission(f), request = await f.requestWaiver(data);
    if (event === 'evidence') await writeFile(data.reproduction.evidence[0], 'New evidence changes the limitation');
    if (event === 'ticket') { f.manifest.snapshot_sha256 = 'changed'; await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest)); }
    if (event === 'block') await f.call('block', { phase: 'investigation', reason: 'Different blocker' });
    if (event === 'reset') await session('reset', 'APP-1', { out: f.out }, { env: {} });
    assert.equal((await f.call('status')).reproduction_request, null);
    await assert.rejects(f.approveWaiver(request), /Earlier required phases|explicit user waiver/);
  }
});

test('schema 6 reopens bug investigation but preserves completed feature work', async t => {
  for (const kind of ['bug', 'feature']) {
    const f = await fixture(t, { kind }); await f.evidence(); await f.investigation(); await f.clarification();
    const path = join(f.out, 'progress.json'), p = await json(path);
    p.version = 6;
    await writeFile(path, JSON.stringify(p));
    const status = await f.call('status');
    assert.equal(status.next_phase, kind === 'bug' ? 'investigation' : 'implementation');
    assert.equal(status.phases.evidence_review, 'complete');
    assert.equal(status.phases.clarification, kind === 'bug' ? 'pending' : 'complete');
    assert.equal((await json(path)).version, 7);
  }
});

test('local reproduction rejects ticket/cache evidence and symlink aliases', async t => {
  const f = await fixture(t, { kind: 'bug' }); await f.evidence();
  const cached = join(f.out, 'evidence'); await mkdir(cached);
  const frame = join(cached, 'frame.png'); await writeFile(frame, 'ticket video frame');
  const attachmentDir = join(f.out, 'attachments'); await mkdir(attachmentDir);
  const attachment = join(attachmentDir, 'screenshot.png'); await writeFile(attachment, 'Jira attachment');
  const alias = await f.artifact('alias.png'); await rm(alias); await symlink(frame, alias);
  for (const path of [join(f.out, 'ticket.md'), join(f.out, 'manifest.json'), frame, attachment, alias]) {
    await assert.rejects(f.investigation({ reproduction: {
      status: 'reproduced', attempted_locally: true, environment: 'local', target: 'localhost', steps: ['Watched ticket video'],
      expected: 'Correct count', actual: 'Incorrect count', evidence: [path],
    } }), /active artifact_directory/);
  }
  await f.investigation();
});

test('ticket videos extracted inside active artifacts are still not local reproduction evidence', async t => {
  const f = await fixture(t, { kind: 'bug' });
  const p = await json(join(f.out, 'progress.json'));
  const directory = join(p.artifact_directory, 'ticket-video'); await mkdir(directory);
  const frame = join(directory, 'frame.png'); await writeFile(frame, 'ticket frame');
  const manifest = join(directory, 'manifest.json'); await writeFile(manifest, '{}');
  f.manifest.attachments = [{ id: '1', status: 'downloaded', is_video: true, video: { status: 'prepared', directory, manifest } }];
  await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest));
  await f.step('evidence_review', { attachments: [{ id: '1', disposition: 'not_relevant', reason: 'Fixture' }], exceptions: [{ code: 'missing_evidence', reason: 'Fixture recording excluded' }] });
  await assert.rejects(f.investigation({ reproduction: { status: 'reproduced', attempted_locally: true, environment: 'local', target: 'localhost', steps: ['Watched ticket frame'], expected: 'Correct count', actual: 'Wrong count', evidence: [frame] } }), /Extracted ticket video/);
});

test('copies and hard links of ticket content or ticket-video extractions are not local evidence', async t => {
  const f = await fixture(t, { kind: 'bug' });
  const attachmentDir = join(f.out, 'attachments'); await mkdir(attachmentDir);
  const attachment = join(attachmentDir, '1-screen.png'); await writeFile(attachment, 'Jira attachment bytes');
  f.manifest.attachments = [{ id: '1', status: 'downloaded', is_video: false, path: attachment, sha256: await hashFile(attachment) }];
  await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest));
  await f.step('evidence_review', { attachments: [{ id: '1', disposition: 'reviewed' }], no_video_reason: 'Ticket has no video attachments' });
  const p = await json(join(f.out, 'progress.json'));
  const hardLink = join(p.artifact_directory, 'linked.png'); await link(attachment, hardLink);
  await writeFile(join(f.out, 'ticket.md'), '# APP-1\n\nLeague count spikes after the tennis sequence.\n');
  await writeFile(join(f.out, 'remote-links.json'), '[]\n');
  const ticketCopy = join(p.artifact_directory, 'ticket-copy.md'); await copyFile(join(f.out, 'ticket.md'), ticketCopy);
  const extracted = join(p.artifact_directory, 'manual-extract'); await mkdir(extracted);
  await writeFile(join(extracted, 'manifest.json'), JSON.stringify({ source_sha256: f.manifest.attachments[0].sha256 }));
  const frame = join(extracted, 'frame-0001.png'); await writeFile(frame, 'Frame decoded from the ticket recording');
  const repro = path => ({ reproduction: { status: 'reproduced', attempted_locally: true, environment: 'local', target: 'localhost', steps: ['Ran app'], expected: 'Correct count', actual: 'Wrong count', evidence: [path] } });
  for (const path of [hardLink, ticketCopy]) await assert.rejects(f.investigation(repro(path)), /Copies of ticket/);
  await assert.rejects(f.investigation(repro(frame)), /extracted from a ticket video/);
  const recording = join(p.artifact_directory, 'local-recording'); await mkdir(recording);
  await writeFile(join(recording, 'manifest.json'), JSON.stringify({ source_sha256: 'local-screen-recording' }));
  await f.investigation(repro(await f.artifact('local-recording/frame-0001.png', 'Frame from the local reproduction recording')));
  await f.call('invalidate', { phase: 'investigation', reason: 'Recheck with an empty API capture' });
  await f.investigation(repro(await f.artifact('empty-response.json', '[]\n')));
});

test('irrelevant not_reproduced exceptions do not trap feature or reproduced-bug clarification', async t => {
  for (const kind of ['feature', 'bug']) {
    const f = await fixture(t, { kind }); await f.evidence();
    await f.investigation({ exceptions: [{ code: 'not_reproduced', reason: 'Unnecessary historical annotation' }] });
    if (kind === 'feature') {
      const path = join(f.out, 'progress.json'), p = await json(path); p.version = 6; await writeFile(path, JSON.stringify(p));
    }
    await f.clarification({ exception_decisions: [{ phase: 'investigation', code: 'not_reproduced', resolution: 'not_material', reason: kind === 'feature' ? 'Feature has no defect to reproduce' : 'Local reproduction is already recorded' }] });
    assert.equal((await f.call('status')).next_phase, 'implementation');
  }
});

test('a pending waiver cannot be silently replaced after start', async t => {
  const f = await fixture(t, { kind: 'bug' }); await f.evidence();
  const request = await f.requestWaiver(await omission(f));
  await assert.rejects(f.requestWaiver({ exceptions: request.report.exceptions, reproduction: { ...request.report.reproduction, reason: 'Changed reason' } }), /Invalidate investigation before replacing/);
  assert.equal((await f.call('status')).reproduction_request.id, request.status.reproduction_request.id);
});

test('reset preserves schema 6 configuration and all feature restrictions', async t => {
  const f = await fixture(t, { scope: 'clarify' });
  const path = join(f.out, 'progress.json'), p = await json(path); p.version = 6;
  await writeFile(path, JSON.stringify(p));
  const status = await session('reset', 'APP-1', { out: f.out }, { env: {} });
  assert.equal(status.next_phase, 'evidence_review');
  assert.deepEqual((await json(path)).config, p.config);
});

test('bug-to-feature reclassification requires an auditable reason', async t => {
  const f = await fixture(t, { kind: 'mixed' });
  const config = { kind: 'feature', scope: 'implement', user_request: 'This request now covers only a new feature', repository: f.repo };
  await assert.rejects(f.call('configure', { input: await f.input(config) }), /reclassification_reason/);
  assert.equal((await f.call('status')).kind, 'mixed');
  await f.call('configure', { input: await f.input({ ...config, reclassification_reason: 'User removed the bug scope; remaining request adds a new feature' }) });
  const p = await json(join(f.out, 'progress.json'));
  assert.ok(p.events.some(e => e.action === 'reclassify' && e.from === 'mixed' && e.to === 'feature' && e.reason));
});

test('schema 5 and 6 mixed sessions reopen investigation through schema 7', async t => {
  for (const version of [5, 6]) {
    const f = await fixture(t, { kind: 'mixed' }); await f.evidence(); await f.investigation(); await f.clarification();
    const path = join(f.out, 'progress.json'), p = await json(path); p.version = version;
    await writeFile(path, JSON.stringify(p));
    const status = await f.call('status');
    assert.equal(status.next_phase, 'investigation'); assert.equal(status.phases.clarification, 'pending');
    assert.equal((await json(path)).version, 7);
  }
});

test('compact CLI preserves actionable state and leaves full API/default output compatible', async t => {
  const { presentStatus } = await import('../scripts/presentation.mjs');
  const f = await fixture(t);
  const cli = (script, args) => JSON.parse(execFileSync(process.execPath, [
    new URL(`../scripts/${script}.mjs`, import.meta.url).pathname, ...args, 'APP-1', '--out', f.out,
  ], { encoding: 'utf8' }));
  const compare = async () => {
    const full = cli('workflow', ['status']);
    assert.deepEqual(full, JSON.parse(JSON.stringify(await f.call('status'))));
    const saved = await readFile(join(f.out, 'progress.json'), 'utf8');
    assert.deepEqual(cli('workflow', ['status', '--format', 'compact']), presentStatus(full, 'compact'));
    assert.equal(await readFile(join(f.out, 'progress.json'), 'utf8'), saved);
    return full;
  };
  await compare();
  await f.start('evidence_review');
  await f.call('block', { phase: 'evidence_review', input: await f.input({ reason: 'Need evidence access', questions: [{ id: 'Q', question: 'Which account?', material: true }] }) });
  const blocked = await compare();
  assert.equal(presentStatus(blocked, 'compact').phase_status, 'blocked');
  const resumed = cli('session', ['continue', '--format', 'compact']);
  assert.deepEqual(resumed.questions, blocked.questions);
  assert.match(resumed.next_action, /Need evidence access/);
  assert.ok(resumed.progress && resumed.manifest && resumed.ticket);
  await f.call('invalidate', { phase: 'evidence_review', reason: 'Access restored' });
  await f.step('evidence_review', { attachments: [], no_video_reason: 'None', resolved_questions: [{ id: 'Q', answer: 'Use the fixture account', source: 'user', user_response: 'Use the fixture account' }] });
  await f.investigation();
  const proposal = await f.present();
  assert.deepEqual(presentStatus(await compare(), 'compact').proposal, proposal.status.proposal);
  await f.approve(proposal); const assigned = await f.handoff();
  const compact = presentStatus(await compare(), 'compact');
  assert.equal(compact.assignment.binding_path, assigned.assignment.binding_path);
  assert.equal(compact.assignment.repository_baseline, undefined);
  await f.implementation(); await f.verification();
  assert.equal((await compare()).done, true);
  const reset = cli('session', ['reset', '--format', 'compact']);
  assert.ok(reset.archive); assert.equal(reset.done, false);
});

test('compact output retains warnings, waiver requests and completion exceptions without mutation', async t => {
  const { presentStatus } = await import('../scripts/presentation.mjs');
  const f = await fixture(t, { kind: 'bug', partial: true });
  await f.evidence([{ code: 'missing_evidence', reason: 'Missing comments' }]);
  const waiver = await f.requestWaiver({ reproduction: { status: 'blocked', attempted_locally: false,
    target: 'local fixture', environment: 'local process', steps: ['Check fixture availability'], expected: 'Data available', actual: 'Data missing',
    evidence: [await f.artifact('blocker.md')], reason: 'Missing data', alternative_verification: 'Use a regression fixture' },
    exceptions: [{ code: 'not_reproduced', reason: 'Missing data' }] });
  f.manifest.refresh_warning = 'Cached evidence; refresh failed';
  await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest));
  const full = await f.call('status'), before = JSON.stringify(full);
  const compact = presentStatus(full, 'compact');
  assert.deepEqual(compact.reproduction_request, waiver.status.reproduction_request);
  assert.deepEqual(compact.exceptions, full.exceptions);
  assert.equal(compact.refresh_warning, f.manifest.refresh_warning);
  assert.equal(JSON.stringify(full), before);
  const review = await fixture(t, { scope: 'review', partial: true });
  await review.evidence([{ code: 'missing_evidence', reason: 'No comments' }]);
  const done = presentStatus(await review.investigation(), 'compact');
  assert.equal(done.outcome, 'complete_with_exceptions'); assert.equal(done.exceptions.length, 1);
});

test('invalid CLI format is rejected before mutation and compact failures still invalidate stale state', async t => {
  const f = await fixture(t); const script = new URL('../scripts/workflow.mjs', import.meta.url).pathname;
  const saved = await readFile(join(f.out, 'progress.json'), 'utf8');
  assert.throws(() => execFileSync(process.execPath, [script, 'start', 'APP-1', '--out', f.out, '--phase', 'evidence_review', '--format', 'bad'], { stdio: 'pipe' }), e => e.status === 1 && /format must/.test(e.stderr));
  assert.equal(await readFile(join(f.out, 'progress.json'), 'utf8'), saved);
  assert.throws(() => execFileSync(process.execPath, [new URL('../scripts/session.mjs', import.meta.url).pathname, 'reset', 'APP-1', '--out', f.out, '--format', 'bad'], { stdio: 'pipe' }), e => e.status === 1 && /format must/.test(e.stderr));
  assert.equal(await readFile(join(f.out, 'progress.json'), 'utf8'), saved);
  await f.evidence(); await f.investigation(); await f.clarification();
  const s = await f.handoff();
  f.manifest.snapshot_sha256 = 'changed'; await writeFile(join(f.out, 'manifest.json'), JSON.stringify(f.manifest));
  assert.throws(() => execFileSync(process.execPath, [script, 'check-worker', 'APP-1', '--out', f.out, '--phase', 'implementation', '--input', s.assignment.binding_path, '--format', 'compact'], { stdio: 'pipe' }), e => e.status === 1 && /Earlier required/.test(e.stderr));
  assert.equal((await json(join(f.out, 'progress.json'))).phases.evidence_review.status, 'pending');
});

test('drafts are fresh incomplete files, preserve questions and cannot refresh existing reports', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('draft', { phase: 'evidence_review' }), /Start the phase/);
  const started = await f.start('evidence_review');
  const one = await f.call('draft', { phase: 'evidence_review' });
  const original = await readFile(one.drafts.evidence_review, 'utf8');
  assert.deepEqual(one.draft_contents.evidence_review, JSON.parse(original));
  assert.equal((await f.call('status')).draft_contents, undefined); // Only the draft response carries skeletons.
  assert.equal(JSON.parse(original).phase_token, started.phase_token);
  await assert.rejects(f.call('complete', { phase: 'evidence_review', input: one.drafts.evidence_review }), /summary/);
  const two = await f.call('draft', { phase: 'evidence_review' });
  assert.notEqual(one.drafts.evidence_review, two.drafts.evidence_review);
  assert.equal(await readFile(one.drafts.evidence_review, 'utf8'), original);
  await assert.rejects(f.call('draft', { phase: 'evidence_review', input: one.drafts.evidence_review }), /never an existing report/);
  await f.call('block', { phase: 'evidence_review', input: await f.input({ reason: 'Missing decision', questions: [{ id: 'Q', question: 'Use partial evidence?', material: true }] }) });
  await f.start('evidence_review');
  const q = await json((await f.call('draft', { phase: 'evidence_review' })).drafts.evidence_review);
  assert.deepEqual(q.resolved_questions, [{ id: 'Q', answer: '', source: '', user_response: '' }]);
  await assert.rejects(f.call('complete', { phase: 'evidence_review', input: one.drafts.evidence_review }), /Stale.*phase_token/);
});

test('clarification drafts do not grant approval or replace pending proposals', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.start('clarification');
  const d = await json((await f.call('draft', { phase: 'clarification' })).drafts.clarification);
  assert.equal(d.alignment, undefined); assert.deepEqual(d.acceptance_criteria, []);
  const p = await f.present();
  await assert.rejects(f.call('draft', { phase: 'clarification' }), /proposal is pending/);
  await assert.rejects(f.call('complete', { phase: 'clarification', input: await f.input(p.report) }), /approval|alignment|confirm/i);
  assert.equal((await f.call('status')).proposal.id, p.status.proposal.id);
});

test('worker drafts require original bindings, remain incomplete and fail after replacement', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const s = await f.handoff();
  await assert.rejects(f.call('draft', { phase: 'implementation' }), /binding/);
  const made = await f.call('draft', { phase: 'implementation', input: s.assignment.binding_path });
  const impl = await json(made.drafts.implementation), verification = await json(made.drafts.verification);
  assert.deepEqual(impl.addressed_criteria, ['AC1']); assert.equal(impl.phase_token, undefined);
  assert.equal(impl.parent_review, undefined); assert.equal(verification.criteria[0].status, '');
  assert.deepEqual(verification.verification_receipts, []);
  await assert.rejects(f.submit('implementation', s.phase_token, impl), /summary/);
  await f.call('block', { phase: 'implementation', input: await f.input({ reason: 'Replace stopped worker', questions: [] }) });
  const replacement = await f.handoff();
  await assert.rejects(f.call('draft', { phase: 'implementation', input: s.assignment.binding_path }), /Stale.*binding/);
  await assert.rejects(f.submit('implementation', replacement.phase_token, { ...impl, summary: 'Old result', artifacts: [await f.artifact('old.md')], changed_files: ['app.js'] }), /Stale.*binding/);
  assert.deepEqual(await json(made.drafts.implementation), impl);
});

test('waiver drafts defer verification until its active phase and preserve alternative plan', async t => {
  const f = await fixture(t, { kind: 'bug' }); await f.evidence();
  const plan = 'Check the regression fixture after implementation';
  const req = await f.requestWaiver({ reproduction: { status: 'blocked', attempted_locally: false, target: 'local fixture', environment: 'local', steps: ['Check data'], expected: 'Data exists', actual: 'Absent', evidence: [await f.artifact('setup.md')], reason: 'No data', alternative_verification: plan }, exceptions: [{ code: 'not_reproduced', reason: 'No data' }] });
  await f.start('investigation');
  await assert.rejects(f.call('draft', { phase: 'investigation' }), /proposal is pending/);
  await f.approveWaiver(req);
  await f.clarification({ reproduction_waiver_id: req.status.reproduction_request.id, exception_decisions: [{ phase: 'investigation', code: 'not_reproduced', resolution: 'accepted_by_user', reason: 'Proceed with fixture regression', waiver_request_id: req.status.reproduction_request.id, user_response: 'User: I approve proceeding without local reproduction for this limitation.' }] });
  const s = await f.handoff();
  const packet = await json(s.assignment.path);
  const runDraft = args => JSON.parse(execFileSync(packet.draft_reports.executable, args, { encoding: 'utf8', stdio: 'pipe' }));
  const made = runDraft(packet.draft_reports.args);
  assert.deepEqual(Object.keys(made.drafts), ['implementation']);
  // Follow the worker brief: change only the phase, retaining the original binding.
  const verificationArgs = [...packet.draft_reports.args];
  verificationArgs[verificationArgs.indexOf('--phase') + 1] = 'verification';
  assert.throws(() => runDraft(verificationArgs), e => e.status === 1 && /Earlier required/.test(e.stderr));
  await f.implementation(); await f.start('verification');
  const oldPhaseArgs = [...packet.draft_reports.args];
  oldPhaseArgs[oldPhaseArgs.indexOf('--response') + 1] = 'unused-response.json';
  assert.throws(() => runDraft(oldPhaseArgs), e => e.status === 1 && /Earlier required/.test(e.stderr));
  const resumed = runDraft(verificationArgs);
  assert.deepEqual(Object.keys(resumed.drafts), ['verification']);
  const v = await json(resumed.drafts.verification);
  for (const [key, value] of Object.entries(await json(s.assignment.binding_path)))
    assert.equal(v[key], value);
  assert.deepEqual(v.reproduction_recheck.alternative_verification, { plan, performed: '', evidence: [] });
  assert.equal(v.reproduction_recheck.status, '');
});

test('draft creation refuses an artifact directory escaping through a symlink', async t => {
  const f = await fixture(t); await f.start('evidence_review');
  const p = await json(join(f.out, 'progress.json'));
  const escape = join(f.out, 'escape'); await symlink(f.repo, escape);
  p.artifact_directory = escape; await writeFile(join(f.out, 'progress.json'), JSON.stringify(p));
  await assert.rejects(f.call('draft', { phase: 'evidence_review' }), /inside the ticket/);
});

test('filled draft reports complete the same receipt-backed workflow', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const s = await f.handoff();
  const cli = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/workflow.mjs', import.meta.url).pathname,
    'draft', 'APP-1', '--out', f.out, '--phase', 'implementation', '--input', s.assignment.binding_path, '--format', 'compact'], { encoding: 'utf8' }));
  const { implementation: impl, verification: v } = cli.draft_contents;
  assert.deepEqual(impl, await json(cli.drafts.implementation));
  assert.deepEqual(v, await json(cli.drafts.verification));
  await writeFile(join(f.repo, 'app.js'), 'export const enabled = true;\n');
  const check = await verify('APP-1', { out: f.out, phase: 'implementation', binding: s.assignment.binding_path },
    [process.execPath, '--input-type=module', '-e', "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.match(readFileSync('app.js', 'utf8'), /enabled = true/)"]);
  await writeFile(cli.drafts.implementation, JSON.stringify({ ...impl, phase_token: s.phase_token,
    parent_review: 'Reviewed AC1 and passing check', repository_review: 'Only app.js changed; no user edits',
    summary: 'Enabled feature', artifacts: [await f.artifact('draft-implementation.md')], changed_files: ['app.js'] }));
  await f.call('complete', { phase: 'implementation', input: cli.drafts.implementation });
  const vs = await f.start('verification');
  await writeFile(cli.drafts.verification, JSON.stringify({ ...v, phase_token: vs.phase_token,
    parent_review: 'Reviewed all criterion evidence and unchanged-code receipt',
    summary: 'Verified feature', artifacts: [await f.artifact('draft-verification.md')],
    criteria: v.criteria.map(c => ({ ...c, status: 'passed', result: 'Enabled export observed', evidence: [check.log] })),
    checks: [{ command: 'Inspect enabled export', exit_code: 0, evidence: check.log }], verification_receipts: [check.receipt] }));
  const done = await f.call('complete', { phase: 'verification', input: cli.drafts.verification });
  assert.equal(done.done, true); assert.equal(done.outcome, 'complete');
});

test('handoff supplies executable draft command, confined worker paths and complete return contract', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const s = await f.handoff(); const packet = await json(s.assignment.path);
  assert.deepEqual(packet.return_reports, ['implementation', 'verification']);
  assert.equal(packet.worker_brief, s.assignment.worker_brief);
  assert.match(await readFile(packet.worker_brief, 'utf8'), /BOTH implementation and verification/);
  const run = JSON.parse(execFileSync('/bin/sh', ['-c', packet.draft_reports.command], { encoding: 'utf8' }));
  for (const path of Object.values(run.drafts)) {
    assert.ok((await realpath(path)).startsWith((await realpath(s.assignment.directory)) + '/'));
    assert.equal((await json(path)).assignment_id, s.assignment.assignment_id);
  }
  assert.deepEqual((await json(run.draft_response)).drafts, run.drafts);
  assert.throws(() => execFileSync(packet.draft_reports.executable, packet.draft_reports.args, { stdio: 'pipe' }), e => e.status === 1 && /response already exists/.test(e.stderr));
  await f.call('block', { phase: 'implementation', input: await f.input({ reason: 'Replace stopped worker', questions: [] }) });
  await f.handoff();
  assert.throws(() => execFileSync(packet.draft_reports.executable, packet.draft_reports.args, { stdio: 'pipe' }), e => e.status === 1 && /Stale.*binding/.test(e.stderr));
});

test('approved implementation context is frozen, passed to workers, and optional for legacy results', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation();
  await assert.rejects(f.present({ implementation_context: '' }), /implementation_context/);
  const context = 'Preserve keyboard focus after Save. User chose the existing role policy; no migration.';
  const proposal = await f.present({ implementation_context: context });
  await assert.rejects(f.approve({ ...proposal, report: { ...proposal.report,
    implementation_context: 'Change the role policy' } }), /proposal|match|changed/i);
  await f.approve(proposal);
  const packet = await json((await f.handoff()).assignment.path);
  assert.equal(packet.requirements.implementation_context, context);
  assert.deepEqual(packet.requirements.acceptance_criteria, proposal.report.acceptance_criteria);
  const legacy = await fixture(t); await legacy.evidence(); await legacy.investigation(); await legacy.clarification();
  const old = await json((await legacy.handoff()).assignment.path);
  assert.equal(old.requirements.implementation_context, undefined);
  assert.ok(old.references.clarification.artifacts.length);
});

test('start with drafts preserves phase gates and saves a confined non-overwriting response', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('start', { phase: 'implementation', draft: true }), /only supported/);
  await assert.rejects(f.call('start', { phase: 'investigation', draft: true }), /Earlier required/);
  await assert.rejects(f.call('start', { phase: 'evidence_review', draft: true, response: '../outside.json' }), /filename/);
  const started = JSON.parse(execFileSync(process.execPath, [new URL('../scripts/workflow.mjs', import.meta.url).pathname,
    'start', 'APP-1', '--out', f.out, '--phase', 'evidence_review', '--draft', '--response', '{phase}-response.json', '--format', 'compact'], { encoding: 'utf8' }));
  assert.equal(started.draft_contents.evidence_review.phase_token, started.phase_token);
  assert.equal(started.draft_response, join(started.artifact_directory, 'evidence_review-response.json'));
  assert.deepEqual(await json(started.draft_response), { drafts: started.drafts, draft_contents: started.draft_contents });
  const before = await readFile(join(f.out, 'progress.json'), 'utf8');
  await assert.rejects(f.call('start', { phase: 'evidence_review', draft: true, response: '{phase}-response.json' }), /already exists/);
  assert.equal(await readFile(join(f.out, 'progress.json'), 'utf8'), before);
  await assert.rejects(f.call('complete', { phase: 'evidence_review', input: started.drafts.evidence_review }), /summary/);
  await f.evidence(); await f.investigation();
  const proposal = await f.present();
  await assert.rejects(f.call('start', { phase: 'clarification', draft: true, response: 'proposal-response.json' }), /proposal is pending/);
  assert.equal((await f.call('status')).proposal.id, proposal.status.proposal.id);
  await assert.rejects(f.start('implementation'), /Earlier required/);
});

test('draft response cannot overwrite a symlink or rescue a stale worker binding', async t => {
  const f = await fixture(t); await f.evidence(); await f.investigation(); await f.clarification();
  const first = await f.handoff();
  const outside = join(f.root, 'untouched.json'); await writeFile(outside, 'untouched');
  await symlink(outside, join(first.assignment.directory, 'response.json'));
  await assert.rejects(f.call('draft', { phase: 'implementation', input: first.assignment.binding_path, response: 'response.json' }), /already exists/);
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
  await f.call('block', { phase: 'implementation', input: await f.input({ reason: 'Stopped worker', questions: [] }) });
  await f.handoff();
  await assert.rejects(f.call('draft', { phase: 'implementation', input: first.assignment.binding_path, response: 'fresh.json' }), /Stale.*binding/);
});

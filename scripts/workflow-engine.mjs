import { repositorySnapshot, validateRepositoryChanges } from './repository.mjs';
import { readFile, realpath, stat, lstat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, hashFile, hashObject, json, privateDir } from './lib.mjs';
import { createHandoff, validateBinding, validateAnswers, activeAssignment } from './handoff.mjs';
import { PHASES, newProgress } from './state.mjs';

function requireThat(condition, message) { if (!condition) throw new Error(message); }
function text(value, name) { requireThat(typeof value === 'string' && value.trim().length > 0, `${name} must be non-empty text`); return value.trim(); }
function list(value, name) { requireThat(Array.isArray(value), `${name} must be an array`); return value; }
function oneOf(value, choices, name) { requireThat(choices.includes(value), `${name} must be one of: ${choices.join(', ')}`); return value; }
function inside(root, file) { const rel = relative(root, file); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel)); }
function record(progress, action, details = {}) {
  progress.revision++;
  progress.events.push({ revision: progress.revision, at: new Date().toISOString(), action, ...details });
}
function phaseLimit(config) { return config?.scope === 'review' ? 1 : config?.scope === 'clarify' ? 2 : 4; }
function resetFrom(progress, phase, reason) {
  const start = PHASES.indexOf(phase);
  requireThat(start >= 0, 'Unknown phase');
  const invalidated = PHASES.slice(start).map(p => ({ phase: p, result_file: progress.phases[p]?.result_file })).filter(p => p.result_file);
  for (const p of PHASES.slice(start)) progress.phases[p] = { status: 'pending', artifacts: [] };
  if (phase === 'verification') progress.phases.verification.assignment_revoked = true;
  if (start === 0) progress.reconciled_snapshot = null;
  // Invalidation must not become a way to erase unanswered material questions.
  // Explicit session reset clears them; ordinary revisions retain them for resolution.
  record(progress, 'invalidate', { phase, reason, invalidated });
}

async function proofFile(path, workDirectory, artifactDirectory) {
  text(path, 'artifact path');
  const file = await realpath(isAbsolute(path) ? path : resolve(artifactDirectory, path));
  const root = await realpath(workDirectory);
  requireThat(inside(root, file), 'Evidence/report artifacts must be inside the ticket work directory');
  const info = await stat(file);
  requireThat(info.isFile() && info.size > 0, `Artifact must be a non-empty file: ${file}`);
  return { path: file, sha256: await hashFile(file) };
}
async function repoFile(path, repository) {
  text(path, 'changed file');
  const root = await realpath(repository), file = resolve(root, path);
  requireThat(inside(root, file) && file !== root, 'Changed files must be inside the configured repository');
  try {
    const actual = await realpath(file);
    requireThat(inside(root, actual), 'Changed file symlink escapes the repository');
    requireThat((await stat(actual)).isFile(), 'Changed paths must be files');
    return { path: file, sha256: await hashFile(actual) };
  } catch (error) { if (error.code === 'ENOENT') {
      // Walk to the nearest existing ancestor, including symlink targets.
      try { requireThat(!(await lstat(file)).isSymbolicLink(), 'Dangling changed-file symlink cannot be recorded as deleted'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      let parent = dirname(file);
      for (;;) {
        try { requireThat(inside(root, await realpath(parent)), 'Deleted file parent escapes the repository'); break; }
        catch (e) {
          if (e.code !== 'ENOENT' || parent === dirname(parent)) throw e;
          try { requireThat(!(await lstat(parent)).isSymbolicLink(), 'Deleted file parent is a dangling symlink'); }
          catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
          parent = dirname(parent);
        }
      }
      return { path: file, sha256: null };
    } throw error; }
}

export async function evidenceFingerprint(manifest) {
  const attachments = [];
  for (const a of manifest.attachments ?? []) {
    let video = null;
    if (a.video?.status === 'prepared') {
      try { video = await hashFile(a.video.manifest); } catch { video = 'missing-manifest'; }
    }
    attachments.push({ id: a.id, sha256: a.sha256, status: a.status, video_status: a.video?.status, video });
  }
  return hashObject({ snapshot: manifest.snapshot_sha256, status: manifest.status, attachments, errors: manifest.errors });
}

export async function synchronize(workDirectory, manifest, previous) {
  let progress = previous;
  if (progress?.version > 6) throw new Error('Saved workflow uses a newer schema; use a newer skill version');
  if (progress?.version === 5) {
    // Keep the mandatory user approval introduced in v5; only execution must restart.
    progress.version = 6;
    if (progress.phases?.clarification?.status === 'complete') {
      const approved = await json(progress.phases.clarification.result_file);
      if (typeof approved.alignment?.proposal_id !== 'string' || !approved.alignment.proposal_id.trim()) resetFrom(progress, 'clarification', 'Legacy approval has no proposal ID');
    }
    if (progress.config?.scope === 'implement') resetFrom(progress, 'implementation', 'Implementation handoff now required; stop any old worker before resuming');
    record(progress, 'upgrade', { from: 5, to: 6 });
  }
  if (!progress || progress.version !== 6) {
    let archive;
    if (progress) {
      await privateDir(join(workDirectory, 'history'));
      archive = join(workDirectory, 'history', `legacy-${randomUUID()}.json`);
      await atomic(archive, { reason: 'migration to validated workflow', progress, artifact_directory: progress.artifact_directory ?? workDirectory });
    }
    const oldScope = progress?.user_scope ?? null;
    progress = await newProgress(manifest.issue_key, workDirectory);
    progress.user_scope = oldScope;
    if (archive) record(progress, 'migrate', { archive });
  }
  requireThat(progress.issue_key === manifest.issue_key, 'Progress and manifest ticket keys differ');
  requireThat(PHASES.every(p => progress.phases?.[p]), 'Invalid workflow phase state; inspect saved progress');
  if (progress.phases.implementation.status === 'complete' && !progress.phases.implementation.repository_snapshot) resetFrom(progress, 'implementation', 'Legacy implementation lacks a repository snapshot; inspect existing work and regenerate handoff');
  const fingerprint = await evidenceFingerprint(manifest);
  if (progress.observed_evidence && progress.observed_evidence !== fingerprint) resetFrom(progress, 'evidence_review', 'Ticket content or evidence availability changed');
  progress.observed_evidence = fingerprint;
  const scopedDone = workflowStatus(progress, manifest).done;
  for (const phase of PHASES) {
    const state = progress.phases[phase];
    if (state.status !== 'complete' && !state.proposal) continue;
    let changed = false;
    for (const artifact of [...(state.artifacts ?? []), { path: state.proposal?.path ?? state.result_file, sha256: state.proposal?.file_sha256 ?? state.result_sha256 }]) {
      try { if (await hashFile(artifact.path) !== artifact.sha256) changed = true; } catch { changed = true; }
    }
    if (phase === 'implementation' && state.repository_snapshot) {
      try {
        const current = await repositorySnapshot(progress.config.repository, workDirectory);
        // Once complete, staging/committing unchanged files does not undo verification.
        const same = scopedDone
          ? current.root === state.repository_snapshot.root && hashObject(current.files) === hashObject(state.repository_snapshot.files)
          : current.sha256 === state.repository_snapshot.sha256;
        if (!same) changed = true;
      }
      catch { changed = true; }
    }
    if (phase === 'implementation') {
      for (const file of state.code_files ?? []) {
        try { if ((await repoFile(file.path, progress.config.repository)).sha256 !== file.sha256) changed = true; } catch { changed = true; }
      }
    }
    if (changed) { resetFrom(progress, phase, 'Accepted report, evidence artifact, or recorded implementation file changed'); break; }
  }
  for (const phase of ['implementation', 'verification']) {
    const assignment = progress.phases[phase].assignment;
    if (!assignment) continue;
    let changed = false;
    for (const [path, hash] of [[assignment.path, assignment.sha256], [assignment.binding_path, assignment.binding_sha256], ...(assignment.repository_baseline ? [[assignment.repository_baseline, assignment.repository_baseline_sha256]] : [])]) {
      try { if (await hashFile(path) !== hash) changed = true; } catch { changed = true; }
    }
    if (changed) {
      resetFrom(progress, phase, 'Worker handoff changed or disappeared; stop the old worker');
      if (phase === 'verification') progress.phases.verification.assignment_revoked = true;
      break;
    }
  }
  progress.next_action = workflowStatus(progress, manifest).next_action;
  return progress;
}

export function workflowStatus(progress, manifest) {
  const max = phaseLimit(progress.config);
  const next = progress.config ? PHASES.slice(0, max + 1).find(p => progress.phases[p].status !== 'complete') : null;
  const done = Boolean(progress.config && !next);
  const exceptions = PHASES.flatMap(phase => (progress.phases[phase].exceptions ?? []).map(e => ({ phase, ...e })));
  return {
    issue_key: progress.issue_key, revision: progress.revision, scope: progress.config?.scope ?? null, kind: progress.config?.kind ?? null,
    artifact_directory: progress.artifact_directory,
    assignment: activeAssignment(progress, next === 'verification' || progress.phases.verification.status === 'complete' ? 'verification' : 'implementation') ?? null,
    refresh_warning: manifest.refresh_warning ?? null,
    phases: Object.fromEntries(PHASES.map((p, i) => [p, i > max && progress.config ? 'not_applicable_to_scope' : progress.phases[p].status])),
    next_phase: next, done, outcome: done ? (exceptions.length ? 'complete_with_exceptions' : 'complete') : 'incomplete', exceptions, evidence_status: manifest.status,
    next_action: !progress.config ? 'Configure the request kind, scope, repository, and user request before starting phases.'
      : done ? 'Report the completed scoped workflow and its recorded limitations.'
      : progress.phases[next].status === 'blocked' ? `Resolve blocker for ${next}: ${progress.phases[next].blocker}`
      : progress.phases[next].proposal ? 'Present the recorded requirements summary to the user and wait for explicit approval of this proposal before completing clarification.'
      : progress.phases[next].status === 'in_progress' ? `Finish ${next} and submit its structured result.` : `Start ${next}.`,
    proposal: next ? progress.phases[next].proposal ?? null : null,
    phase_token: next ? progress.phases[next].token ?? null : null,
    questions: progress.unresolved_questions ?? [],
  };
}

function currentPhase(progress, manifest, phase) {
  requireThat(progress.config, 'Configure the workflow first');
  oneOf(phase, PHASES, 'phase');
  requireThat(PHASES.indexOf(phase) <= phaseLimit(progress.config), 'This phase is outside the user-requested scope');
  requireThat(workflowStatus(progress, manifest).next_phase === phase, 'Earlier required phases must be complete; invalidate a completed phase before revising it');
}

async function validateResult(phase, report, progress, manifest, workDirectory) {
  text(report.summary, 'summary');
  const artifacts = [];
  for (const path of list(report.artifacts, 'artifacts')) artifacts.push(await proofFile(path, workDirectory, progress.artifact_directory));
  requireThat(artifacts.length > 0, 'At least one report/evidence artifact is required');
  const active = await realpath(progress.artifact_directory);
  requireThat(artifacts.some(a => inside(active, a.path)), 'At least one report must be in the active workflow artifact directory');
  const exceptions = list(report.exceptions ?? [], 'exceptions');
  for (const exception of exceptions) { text(exception.code, 'exception.code'); text(exception.reason, 'exception.reason'); }
  const requiredException = (code, reason) => requireThat(exceptions.some(e => e.code === code), `${reason}; record an explicit ${code} exception`);
  validateAnswers(progress, phase, report.resolved_questions);
  let codeFiles;
  if (phase === 'evidence_review') {
    if (manifest.status !== 'complete') requiredException('missing_evidence', 'Preparation is partial');
    const reviewed = list(report.attachments, 'attachments');
    const source = manifest.attachments ?? [];
    requireThat(reviewed.length === source.length && new Set(reviewed.map(a => String(a.id))).size === reviewed.length, 'Address every attachment exactly once');
    for (const item of reviewed) {
      const a = source.find(s => String(s.id) === String(item.id));
      requireThat(a, `Unknown attachment ${item.id}`);
      oneOf(item.disposition, ['reviewed', 'not_relevant', 'unavailable'], 'attachment disposition');
      if (item.disposition !== 'reviewed') {
        text(item.reason, 'attachment reason');
        if (item.disposition === 'unavailable' || a.is_video) requiredException('missing_evidence', 'An unavailable attachment or excluded video was not reviewed');
        continue;
      }
      requireThat(a.status === 'downloaded', 'Cannot claim review of an undownloaded attachment');
      if (a.is_video) {
        requireThat(a.video?.status === 'prepared', 'Cannot claim video review without prepared frames');
        const video = await json(a.video.manifest);
        const inspected = list(item.inspected_files, 'video inspected_files');
        const inspectedPaths = [];
        for (const path of inspected) { const proof = await proofFile(path, workDirectory, progress.artifact_directory); inspectedPaths.push(proof.path); artifacts.push(proof); }
        for (const sheet of video.contact_sheets) requireThat(inspectedPaths.includes(await realpath(join(a.video.directory, sheet))), 'Record every overview contact sheet as inspected');
        const observations = list(item.observations, 'video observations');
        requireThat(observations.length > 0, 'Video review requires timestamped observations');
        for (const o of observations) { requireThat(Number.isFinite(o.timestamp_seconds) && o.timestamp_seconds >= 0 && o.timestamp_seconds <= video.duration_seconds, 'Observation timestamp is outside the video'); text(o.observation, 'observation'); }
      }
    }
    if (!source.some(a => a.is_video)) text(report.no_video_reason, 'no_video_reason');
  }
  if (phase === 'investigation') {
    text(report.current_behavior, 'current_behavior');
    list(report.relevant_files, 'relevant_files').forEach(f => text(f, 'relevant file'));
    if (['bug', 'mixed'].includes(progress.config.kind)) {
      const r = report.reproduction;
      requireThat(r && typeof r === 'object', 'Bug and mixed requests require reproduction results');
      oneOf(r.status, ['reproduced', 'not_reproduced', 'blocked'], 'reproduction.status');
      text(r.environment, 'reproduction.environment');
      requireThat(list(r.steps, 'reproduction.steps').length > 0, 'Record reproduction steps or attempted setup steps');
      r.steps.forEach(s => text(s, 'reproduction step'));
      text(r.expected, 'reproduction.expected'); text(r.actual, 'reproduction.actual');
      if (r.status !== 'reproduced') { text(r.reason, 'reproduction.reason'); requiredException('not_reproduced', 'The bug was not reproduced'); }
    }
    if (['feature', 'mixed'].includes(progress.config.kind)) { text(report.feature_analysis, 'feature_analysis'); list(report.constraints, 'constraints'); }
  }
  if (phase === 'clarification') {
    const criteria = list(report.acceptance_criteria, 'acceptance_criteria');
    requireThat(criteria.length > 0 && new Set(criteria.map(c => c.id)).size === criteria.length, 'Acceptance criteria must have unique IDs and cannot be empty');
    for (const c of criteria) { text(c.id, 'criterion.id'); text(c.requirement, 'criterion.requirement'); text(c.verification, 'criterion.verification'); }
    list(report.scope_exclusions, 'scope_exclusions');
    const questions = list(report.questions, 'questions');
    for (const q of questions) {
      text(q.question, 'question'); requireThat(typeof q.material === 'boolean', 'question.material must be boolean');
      if (q.material) { text(q.answer, 'material question answer'); text(q.user_response, 'material question user_response'); }
      else if (!q.answer) text(q.assumption, 'unanswered nonmaterial question assumption');
    }
    for (const earlier of ['evidence_review', 'investigation']) {
      const result = await json(progress.phases[earlier].result_file);
      for (const exception of result.exceptions ?? []) {
        const resolution = list(report.exception_decisions ?? [], 'exception_decisions').find(d => d.phase === earlier && d.code === exception.code);
        requireThat(resolution, `Resolve ${earlier}/${exception.code} before implementation`);
        oneOf(resolution.resolution, ['resolved', 'not_material', 'accepted_by_user'], 'exception resolution');
        text(resolution.reason, 'exception decision reason');
        if (resolution.resolution === 'accepted_by_user') text(resolution.user_response, 'exception user response');
        if (resolution.resolution === 'resolved') requireThat(list(resolution.evidence, 'resolution evidence').length > 0, 'Resolved exceptions need evidence');
        for (const path of resolution.evidence ?? []) artifacts.push(await proofFile(path, workDirectory, progress.artifact_directory));
      }
    }
  }
  if (phase === 'implementation') {
    const requirements = await json(progress.phases.clarification.result_file);
    const addressed = list(report.addressed_criteria, 'addressed_criteria');
    requireThat(addressed.length === requirements.acceptance_criteria.length && new Set(addressed).size === addressed.length && requirements.acceptance_criteria.every(c => addressed.includes(c.id)), 'Implementation must address exactly the agreed acceptance criteria');
    codeFiles = [];
    for (const path of list(report.changed_files, 'changed_files')) codeFiles.push(await repoFile(path, progress.config.repository));
    if (!codeFiles.length) { text(report.no_change_reason, 'no_change_reason'); requiredException('no_code_change', 'No implementation files were recorded'); }
  }
  if (phase === 'verification') {
    const requirements = await json(progress.phases.clarification.result_file);
    const checks = list(report.criteria, 'criteria');
    requireThat(checks.length === requirements.acceptance_criteria.length && new Set(checks.map(c => c.id)).size === checks.length && requirements.acceptance_criteria.every(c => checks.some(v => v.id === c.id)), 'Verification must cover each agreed criterion exactly once');
    for (const check of checks) {
      requireThat(check.status === 'passed', `Criterion ${check.id} is not passed; block verification instead of completing`);
      text(check.result, 'criterion result');
      requireThat(list(check.evidence, 'criterion evidence').length > 0, 'Each criterion needs evidence');
      for (const path of check.evidence) artifacts.push(await proofFile(path, workDirectory, progress.artifact_directory));
    }
    const tests = list(report.checks, 'checks');
    if (!tests.length) text(report.no_tests_reason, 'no_tests_reason');
    for (const check of tests) { text(check.command, 'check command'); requireThat(check.exit_code === 0, 'Failing checks cannot complete verification'); artifacts.push(await proofFile(check.evidence, workDirectory, progress.artifact_directory)); }
    if (['bug', 'mixed'].includes(progress.config.kind)) {
      oneOf(report.reproduction_recheck?.status, ['passed', 'not_reproduced'], 'reproduction_recheck.status');
      text(report.reproduction_recheck.result, 'reproduction_recheck.result');
      if (report.reproduction_recheck.status === 'not_reproduced') {
        const investigation = await json(progress.phases.investigation.result_file);
        requireThat(investigation.reproduction.status !== 'reproduced', 'A previously reproduced bug requires a passing reproduction recheck');
        requiredException('runtime_unverified', 'Runtime reproduction remains unverified');
      }
    }
  }
  return { artifacts: [...new Map(artifacts.map(a => [a.path, a])).values()], codeFiles, exceptions };
}

// Approval and execution tokens are not part of the requirements being approved.
function proposalContent(report) {
  const { alignment, phase_token, ...proposal } = report;
  return proposal;
}

export async function transition(progress, manifest, workDirectory, action, phase, input = {}) {
  if (action === 'configure') {
    requireThat(input.requires_user_confirmation === undefined || input.requires_user_confirmation === true, 'Explicit user confirmation is mandatory; it cannot be disabled');
    const config = {
      kind: oneOf(input.kind, ['bug', 'feature', 'mixed'], 'kind'), scope: oneOf(input.scope, ['review', 'clarify', 'implement'], 'scope'),
      user_request: text(input.user_request, 'user_request'), repository: await realpath(text(input.repository, 'repository')),
      requires_user_confirmation: true,
    };
    requireThat((await stat(config.repository)).isDirectory(), 'repository must be a directory');
    requireThat(!inside(await realpath(workDirectory), config.repository), 'Repository must not equal or be inside the ticket work directory');
    if (hashObject(config) !== hashObject(progress.config)) {
      resetFrom(progress, 'evidence_review', 'Workflow configuration changed');
      progress.config = config; progress.user_scope = config.user_request;
      record(progress, 'configure', { config });
    }
  } else if (action === 'invalidate') {
    oneOf(phase, PHASES, 'phase'); resetFrom(progress, phase, text(input.reason, 'reason'));
  } else if (action !== 'status') {
    currentPhase(progress, manifest, phase);
    const state = progress.phases[phase];
    if (action === 'start') {
      if (state.status !== 'in_progress') {
        state.status = 'in_progress'; state.token = randomUUID(); delete state.blocker;
        record(progress, 'start', { phase });
      }
    } else if (action === 'handoff') {
      requireThat(['implementation', 'verification'].includes(phase) && state.status === 'in_progress', 'Start implementation or verification before creating a handoff');
      requireThat(input.phase_token === state.token, 'Stale or missing phase_token; use the token returned by start');
      state.assignment = await createHandoff(progress, workDirectory, input, phase);
      record(progress, 'handoff', { assignment: state.assignment });
    } else if (action === 'check-worker') {
      requireThat(['implementation', 'verification'].includes(phase) && state.status === 'in_progress', 'Worker may act only during active implementation or verification');
      validateBinding(progress, input, phase);
    } else if (action === 'record-check') {
      requireThat(['implementation', 'verification'].includes(phase) && state.status === 'in_progress', 'Checks require an active implementation or verification phase');
      const assignment = validateBinding(progress, input, phase);
      const proof = await proofFile(input.receipt, workDirectory, progress.artifact_directory);
      const receipt = await json(proof.path);
      validateBinding(progress, receipt, phase);
      requireThat(receipt.before.sha256 === receipt.after.sha256 && receipt.after.sha256 === (await repositorySnapshot(progress.config.repository, workDirectory)).sha256, 'Code changed while the check ran; rerun verification');
      requireThat(receipt.exit_code === 0, 'Failing checks cannot be registered as passing');
      const log = await proofFile(receipt.log, workDirectory, progress.artifact_directory);
      requireThat(log.sha256 === receipt.log_sha256, 'Check log changed');
      assignment.checks ??= [];
      assignment.checks.push({ ...proof, log, repository_sha256: receipt.after.sha256 });
      record(progress, 'record-check', { phase, receipt: proof.path });
    } else if (action === 'assert') {
      requireThat(state.status === 'in_progress', 'Start the phase before taking its actions');
      if (phase === 'implementation') requireThat(state.assignment, 'Create an implementation handoff before editing');
    } else if (action === 'block') {
      requireThat(['in_progress', 'blocked'].includes(state.status), 'Start the phase before blocking it');
      if (phase === 'verification') state.assignment_revoked = true;
      delete state.proposal; delete state.assignment; state.artifacts = [];
      state.status = 'blocked'; state.blocker = text(input.reason, 'reason'); delete state.token;
      for (const q of list(input.questions ?? [], 'questions')) {
        text(q.id, 'question.id'); text(q.question, 'question'); requireThat(typeof q.material === 'boolean', 'question.material must be boolean');
        const existing = (progress.unresolved_questions ?? []).find(old => old.id === q.id);
        requireThat(!existing || (existing.phase === phase && existing.question === q.question && existing.material === q.material), 'Question IDs must be unique unless re-blocking the same pending question');
        if (!existing) progress.unresolved_questions.push({ ...q, phase });
      }
      record(progress, 'block', { phase, reason: state.blocker });
    } else if (action === 'present') {
      requireThat(phase === 'clarification', 'Only clarification has a proposal presentation step');
      requireThat(state.status === 'in_progress', 'Start clarification before presenting its proposal');
      requireThat(input.phase_token === state.token, 'Stale or missing phase_token; use the token returned by start');
      requireThat(input.alignment === undefined, 'Present the proposal before recording approval');
      const validated = await validateResult(phase, input, progress, manifest, workDirectory);
      const proposal = proposalContent(input);
      const path = join(progress.artifact_directory, `proposal-${randomUUID()}.json`);
      await atomic(path, proposal);
      state.artifacts = validated.artifacts;
      state.proposal = { id: randomUUID(), sha256: hashObject(proposal), path, file_sha256: await hashFile(path), presented_at: new Date().toISOString() };
      record(progress, 'present', { phase, proposal: state.proposal });
    } else if (action === 'complete') {
      requireThat(state.status === 'in_progress', 'Start or resume the phase before completing it');
      requireThat(typeof input.phase_token === 'string' && input.phase_token === state.token, 'Stale or missing phase_token; use the token returned by start');
      const validated = await validateResult(phase, input, progress, manifest, workDirectory);
      if (phase === 'clarification') {
        requireThat(state.proposal, 'Present the requirements proposal and obtain explicit user approval before completing clarification');
        requireThat(hashObject(proposalContent(input)) === state.proposal.sha256, 'Requirements changed since presentation; present the revised proposal and obtain new approval');
        const alignment = input.alignment;
        requireThat(alignment?.status === 'confirmed_by_user', 'Explicit user approval of the presented proposal is required');
        requireThat(alignment.proposal_id === state.proposal.id, 'Approval must reference the current proposal_id');
        text(alignment.user_response, 'alignment.user_response');
        text(alignment.rationale, 'alignment.rationale');
      }
      if (['implementation', 'verification'].includes(phase)) {
        validateBinding(progress, input, phase);
        text(input.parent_review, 'parent_review');
      }
      let repositoryState;
      if (phase === 'implementation') {
        const assignment = validateBinding(progress, input, phase);
        requireThat(assignment.repository_baseline, 'Legacy handoff needs replacement to capture repository state');
        repositoryState = await repositorySnapshot(progress.config.repository, workDirectory);
        validateRepositoryChanges(await json(assignment.repository_baseline), repositoryState, input.changed_files, input.repository_review);
      }
      if (phase === 'verification') {
        const assignment = validateBinding(progress, input, phase);
        const receipts = list(input.verification_receipts, 'verification_receipts');
        requireThat(receipts.length > 0, 'At least one recorded verification receipt is required');
        const current = await repositorySnapshot(progress.config.repository, workDirectory);
        const logs = new Set();
        for (const path of receipts) {
          const proof = await proofFile(path, workDirectory, progress.artifact_directory);
          const saved = (assignment.checks ?? []).find(c => c.path === proof.path && c.sha256 === proof.sha256);
          requireThat(saved && saved.repository_sha256 === current.sha256, 'Verification receipt is stale or unregistered; rerun checks for this code');
          requireThat(await hashFile(saved.log.path) === saved.log.sha256, 'Verification log changed');
          validated.artifacts.push(proof, saved.log);
          logs.add(saved.log.path);
        }
        for (const check of input.checks) requireThat(logs.has((await proofFile(check.evidence, workDirectory, progress.artifact_directory)).path), 'Each check must use a recorded verification log');
      }
      const resultFile = join(progress.artifact_directory, `${phase}-${randomUUID()}.json`);
      await atomic(resultFile, { ...input, exceptions: validated.exceptions });
      progress.phases[phase] = { status: 'complete', assignment: state.assignment, assignment_revoked: state.assignment_revoked, repository_snapshot: repositoryState, artifacts: validated.artifacts, result_file: resultFile, result_sha256: await hashFile(resultFile), code_files: validated.codeFiles, exceptions: validated.exceptions, completed_at: new Date().toISOString() };
      progress.unresolved_questions = progress.unresolved_questions.filter(q => q.phase !== phase);
      if (phase === 'evidence_review') progress.reconciled_snapshot = manifest.snapshot_sha256;
      record(progress, 'complete', { phase, result_file: resultFile, exceptions: validated.exceptions });
    } else throw new Error('Unknown workflow action');
  }
  const status = workflowStatus(progress, manifest);
  progress.next_action = status.next_action;
  return status;
}

export async function readInput(path) {
  requireThat((await stat(path)).size <= 2 * 1024 * 1024, 'Structured input exceeds 2 MiB');
  return JSON.parse(await readFile(path, 'utf8'));
}

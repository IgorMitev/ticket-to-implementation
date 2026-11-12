import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { repositorySnapshot, validateRepositoryChanges } from '../scripts/repository.mjs';
import { cleanup } from '../scripts/cleanup.mjs';
import { newProgress } from '../scripts/state.mjs';
test('Git baseline captures user changes and refuses a branch switch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repo-baseline-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']);
  await writeFile(join(root, 'app.js'), 'original');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture']);
  await writeFile(join(root, 'app.js'), 'user edits');
  const before = await repositorySnapshot(root);
  assert.equal(before.mode, 'git'); assert.equal(before.branch, 'main');
  await writeFile(join(root, 'app.js'), 'user edits plus implementation');
  const after = await repositorySnapshot(root);
  assert.deepEqual(validateRepositoryChanges(before, after, ['app.js'], 'Preserved user edits'), ['app.js']);
  git(['switch', '-c', 'other']);
  assert.throws(() => validateRepositoryChanges(before, { ...after, branch: 'other' }, ['app.js'], 'reviewed'), /branch or HEAD/);
});
test('cleanup dry run protects referenced media and all approval/history records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cache-prune-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'identity.json'), '{"key":"APP-1"}');
  const progress = await newProgress('APP-1', root);
  await writeFile(join(root, 'progress.json'), JSON.stringify(progress));
  for (const path of ['evidence/keep', 'evidence/orphan', 'refresh-attempts/old', 'history']) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'note.json'), '{}');
    await utimes(join(root, path), new Date(0), new Date(0));
  }
  await writeFile(join(root, 'history', 'approved.json'), JSON.stringify({ media: join(root, 'evidence/keep/frame.png') }));
  const dry = await cleanup(root);
  assert.equal(dry.candidates.length, 2); assert.deepEqual(dry.removed, []);
  const result = await cleanup(root, { apply: true }); assert.equal(result.removed.length, 2);
  assert.equal((await cleanup(root)).candidates.length, 0);
  progress.phases.implementation.status = 'in_progress';
  await writeFile(join(root, 'progress.json'), JSON.stringify(progress));
  await assert.rejects(cleanup(root, { apply: true }), /Stop active workflow/);
});

test('snapshot rejects repository inside workdir and explains nested Git clones', async t => {
  const root = await mkdtemp(join(tmpdir(), 'repo-layout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); await mkdir(repo); await writeFile(join(repo, 'app.js'), 'code');
  await assert.rejects(repositorySnapshot(repo, root), /inside the ticket work directory/);
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'], { stdio: 'pipe' });
  const nested = join(repo, 'vendor-clone'); await mkdir(nested);
  execFileSync('git', ['-C', nested, 'init', '-b', 'main'], { stdio: 'pipe' });
  await writeFile(join(nested, 'file'), 'nested');
  execFileSync('git', ['-C', nested, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', nested, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'], { stdio: 'pipe' });
  await assert.rejects(repositorySnapshot(repo), /nested Git repository.*gitignore/);
  await writeFile(join(repo, '.gitignore'), 'vendor-clone/\n');
  assert.ok((await repositorySnapshot(repo)).files['app.js']);
});

test('cleanup validates inputs and protects URL-encoded Markdown references', async t => {
  await assert.rejects(cleanup(undefined), /Provide --out/);
  const root = await mkdtemp(join(tmpdir(), 'cleanup-input-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'identity.json'), '{"key":"APP-1"}');
  await writeFile(join(root, 'progress.json'), '{}');
  await assert.rejects(cleanup(root), /Invalid progress/);
  await writeFile(join(root, 'progress.json'), JSON.stringify(await newProgress('APP-1', root)));
  const path = join(root, 'evidence', 'detail 12-16'); await mkdir(path, { recursive: true });
  await utimes(path, new Date(0), new Date(0));
  await writeFile(join(root, 'review.md'), '[Evidence](evidence/detail%2012-16/frame.png)');
  assert.deepEqual((await cleanup(root, { apply: true })).removed, []);
});

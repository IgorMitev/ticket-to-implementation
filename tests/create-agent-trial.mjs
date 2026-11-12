import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { newProgress } from '../scripts/state.mjs';
import { atomic, isMain } from '../scripts/lib.mjs';

export async function createAgentTrial() {
  const root = await mkdtemp(join(tmpdir(), 'ticket-agent-trial-'));
  const repository = join(root, 'repository'), work = join(root, 'ticket');
  await mkdir(repository); await mkdir(work);
  await writeFile(join(repository, 'slug.mjs'), 'export const slug = value => value.toLowerCase();\n');
  await writeFile(join(repository, 'slug.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slug } from './slug.mjs';\ntest('lowercases a label', () => assert.equal(slug('Example'), 'example'));\n");
  await writeFile(join(repository, 'notes.txt'), 'Existing project note.\n');
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial fixture']);
  await writeFile(join(repository, 'notes.txt'), 'Existing project note.\nUser draft: preserve this line.\n');
  await writeFile(join(work, 'ticket.md'), '# TRIAL-1: Normalize label whitespace for URL slugs\n\nTrim leading/trailing whitespace and collapse internal whitespace to a hyphen. Retain lowercase behavior. Settle punctuation behavior with the user before coding. No UI or dependencies.\n\nNo attachments.\n');
  await atomic(join(work, 'identity.json'), { key: 'TRIAL-1' });
  await atomic(join(work, 'manifest.json'), { issue_key: 'TRIAL-1', status: 'complete', snapshot_sha256: 'trial-snapshot-one', fetched_at: new Date().toISOString(), attachments: [], errors: [] });
  await atomic(join(work, 'progress.json'), await newProgress('TRIAL-1', work));
  return { root, repository, work_directory: work, key: 'TRIAL-1' };
}
if (isMain(import.meta.url)) console.log(JSON.stringify(await createAgentTrial()));

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Provision a fresh, isolated run. Existing run directories are never overwritten.
const [skillArg, runArg] = process.argv.slice(2);
if (!skillArg || !runArg) throw new Error('Usage: node setup.mjs SKILL_DIRECTORY NEW_RUN_DIRECTORY');
const skill = resolve(skillArg), root = resolve(runArg);
await mkdir(root); // Deliberately refuse accidental reuse.
const repo = join(root, 'repo'), ticket = join(root, 'ticket');
await mkdir(repo);
const put = (name, content) => writeFile(join(repo, name), content);
await put('AGENTS.md', '# Repository instructions\n\nUse Node built-ins only. Run `node --test`. Preserve unrelated user changes. Keep the public `slug` export and string-only API.\n');
await put('slug.mjs', 'export const slug = value => value.toLowerCase();\n');
await put('slug.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slug } from './slug.mjs';\ntest('lowercases a label', () => assert.equal(slug('Example'), 'example'));\n");
await put('notes.txt', 'Existing project note.\n');
const git = args => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git(['init', '-b', 'main']); git(['add', '.']);
git(['-c', 'user.name=Mock Fixture', '-c', 'user.email=mock@example.test', 'commit', '-m', 'Initial slug feature fixture']);
await put('notes.txt', 'Existing project note.\nUser draft: preserve this line.\n');
const fixture = JSON.parse(await readFile(new URL('./jira.json', import.meta.url), 'utf8'));
const attachment = await readFile(new URL('./requirements.txt', import.meta.url));
const { prepareTicket } = await import(pathToFileURL(join(skill, 'scripts/prepare-ticket.mjs')));
const fetchImpl = async url => {
  if (url.endsWith('/remotelink')) return Response.json([]);
  if (url.includes('/comment?')) {
    const start = Number(new URL(url).searchParams.get('startAt'));
    return Response.json({ total: fixture.comments.length, comments: fixture.comments.slice(start, start + 12) });
  }
  if (url.includes('/attachment/content/42')) return new Response(attachment);
  if (url.includes('/issue/MOCK-1')) return Response.json(fixture.issue);
  throw new Error(`Unexpected mock request: ${url}`);
};
const manifest = await prepareTicket('MOCK-1', { out: ticket }, {
  env: { JIRA_BASE_URL: 'https://mock.invalid', JIRA_EMAIL: 'mock@example.test', JIRA_API_TOKEN: 'offline-fixture-not-a-secret' }, fetchImpl,
});
const config = { key: 'MOCK-1', skill, root, repository: repo, work_directory: ticket,
  fixture: fileURLToPath(new URL('./jira.json', import.meta.url)), snapshot_sha256: manifest.snapshot_sha256 };
await writeFile(join(root, 'run.json'), JSON.stringify(config, null, 2) + '\n');
console.log(JSON.stringify(config));

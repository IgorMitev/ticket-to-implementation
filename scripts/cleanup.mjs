import { readdir, readFile, lstat, rm, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { acquireLock, PHASES } from './state.mjs';
import { args, isMain, json } from './lib.mjs';

// Deliberately never remove attachments, workflow reports, approval or history.
export async function cleanup(directory, { apply = false, days = 30, now = Date.now() } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Provide --out with an existing ticket work directory');
  if (!Number.isFinite(days) || days < 1) throw new Error('Retention days must be at least 1');
  const root = await realpath(resolve(directory));
  const release = await acquireLock(root, { timeoutMs: 3000 });
  try {
    await json(join(root, 'identity.json'));
    const progress = await json(join(root, 'progress.json'));
    if (!progress || typeof progress !== 'object' || !PHASES.every(phase => ['pending', 'in_progress', 'blocked', 'complete'].includes(progress.phases?.[phase]?.status))) throw new Error('Invalid progress: expected all workflow phases and statuses; refusing cleanup');
    if (progress.version > 6) throw new Error('Newer workflow schema; use a newer skill version');
    if (Object.values(progress.phases).some(p => p.status === 'in_progress' || p.status === 'blocked')) throw new Error('Stop active workflow work before cache cleanup');
    const documents = [];
    async function scan(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { if (!['attachments', 'evidence', 'node_modules', '.git'].includes(entry.name)) await scan(path); }
        else if (/\.(json|md)$/.test(entry.name)) {
          if ((await lstat(path)).size > 8 * 1024 * 1024) throw new Error('Reference document too large to safely scan: ' + path);
          const text = await readFile(path, 'utf8');
          documents.push(text);
          // Decode URL-encoded Markdown paths without letting malformed escapes hide references.
          documents.push(text.replace(/(?:%[0-9a-fA-F]{2})+/g, encoded => {
            try { return decodeURIComponent(encoded); } catch { return encoded; }
          }));
        }
      }
    }
    await scan(root);
    const candidates = [];
    for (const group of ['refresh-attempts', 'evidence']) {
      const parent = join(root, group);
      try {
        if ((await lstat(parent)).isSymbolicLink()) throw new Error('Cleanup root must not be a symlink');
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const path = join(parent, entry.name), rel = group + '/' + entry.name;
          if ((await lstat(path)).mtimeMs > now - days * 86400000) continue;
          if (documents.some(text => text.includes(path) || text.includes(rel) || text.includes(JSON.stringify(entry.name)))) continue;
          candidates.push(path);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (apply) for (const path of candidates) await rm(path, { recursive: true });
    return { dry_run: !apply, retention_days: days, candidates, removed: apply ? candidates : [] };
  } finally { await release(); }
}
if (isMain(import.meta.url)) {
  try {
    const { values } = args({ out: { type: 'string' }, days: { type: 'string' }, apply: { type: 'boolean' } });
    if (values.help) console.log('Usage: node cleanup.mjs --out WORK_DIR [--days 30] [--apply]. Dry run by default; preserves referenced media and all approval/history records.');
    else console.log(JSON.stringify(await cleanup(values.out, { apply: values.apply, days: values.days === undefined ? 30 : Number(values.days) })));
  } catch (error) { console.error(error.message); process.exitCode = error.code === 'LOCK_BUSY' ? 3 : 1; }
}

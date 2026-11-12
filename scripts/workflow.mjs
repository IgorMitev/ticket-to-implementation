import { join, resolve } from 'node:path';
import { args, atomic, json, isMain } from './lib.mjs';
import { acquireLock, defaultWorkDir } from './state.mjs';
import { endpoints } from './prepare-ticket.mjs';
import { synchronize, transition, readInput } from './workflow-engine.mjs';

export async function workflow(action, key, options = {}, { env = process.env } = {}) {
  if (!['configure', 'status', 'start', 'assert', 'block', 'present', 'request-reproduction-waiver', 'handoff', 'check-worker', 'record-check', 'complete', 'invalidate'].includes(action)) throw new Error('Unknown workflow action');
  key = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error('Use a Jira issue key such as ABC-123');
  const out = resolve(options.out ?? defaultWorkDir(endpoints(env), key));
  const release = await acquireLock(out, { timeoutMs: 3000 });
  try {
    if ((await json(join(out, 'identity.json'))).key !== key) throw new Error('Work directory belongs to another ticket');
    const manifest = await json(join(out, 'manifest.json'));
    const progressFile = join(out, 'progress.json');
    const progress = await synchronize(out, manifest, await json(progressFile));
    // Persist invalidation even when the requested transition is then rejected.
    await atomic(progressFile, progress);
    const input = options.input ? await readInput(resolve(options.input)) : {};
    if (options.reason) input.reason = options.reason;
    const status = await transition(progress, manifest, out, action, options.phase, input);
    await atomic(progressFile, progress);
    return { ...status, work_directory: out, progress: progressFile };
  } finally { await release(); }
}

if (isMain(import.meta.url)) {
  try {
    const { values, positionals } = args({ out: { type: 'string' }, phase: { type: 'string' }, input: { type: 'string' }, reason: { type: 'string' } });
    if (values.help) console.log('Usage: node workflow.mjs configure|status|start|assert|block|present|request-reproduction-waiver|handoff|check-worker|record-check|complete|invalidate ABC-123 [--out WORK_DIR --phase PHASE --input JSON_FILE --reason TEXT]');
    else {
      if (positionals.length !== 2) throw new Error('Provide an action and Jira issue key');
      console.log(JSON.stringify(await workflow(positionals[0], positionals[1], values)));
    }
  } catch (error) { console.error(error.message); process.exitCode = error.code === 'LOCK_BUSY' ? 3 : 1; }
}

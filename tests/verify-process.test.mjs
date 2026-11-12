import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck } from '../scripts/verify.mjs';

test('verification exits promptly when background descendants inherit pipes', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'check-process-')); t.after(() => rm(root, { recursive: true, force: true }));
  const log = join(root, 'log');
  const start = Date.now();
  const result = await runCheck(['sh', '-c', 'echo started; (sleep 6) & exit 0'], root, createWriteStream(log), 3000);
  assert.equal(result.code, 0);
  assert.ok(Date.now() - start < 2000);
  assert.match(await readFile(log, 'utf8'), /started/);
});

test('verification timeout terminates resistant child and returns a timeout outcome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'check-timeout-')); t.after(() => rm(root, { recursive: true, force: true }));
  const start = Date.now();
  const result = await runCheck([process.execPath, '-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},100)'], root, createWriteStream(join(root, 'log')), 200);
  assert.equal(result.code, 124);
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - start < 2500);
});

for (const scenario of ['SIGINT', 'group-SIGINT', 'SIGTERM', 'exit']) {
  test('runner interruption cleans its detached process group: ' + scenario, { skip: process.platform === 'win32', timeout: 10000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'check-interrupt-'));
    let wrapper, pids;
    t.after(async () => {
      for (const pid of [wrapper?.pid, pids?.child]) {
        if (!pid) continue;
        try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    });
    const ready = join(root, 'ready.json');
    const grandchildCode = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      const grand=spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'inherit'});
      fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({child:process.pid,grandchild:grand.pid}));
      setInterval(()=>{},1000);`;
    const script = join(root, 'runner.mjs');
    await writeFile(script, `import {runCheck} from ${JSON.stringify(new URL('../scripts/verify.mjs', import.meta.url).href)};
      import {createWriteStream} from 'node:fs';
      process.on('message',m=>{if(m==='exit')process.exit(7)});
      await runCheck(${JSON.stringify([process.execPath, '-e', childCode])},${JSON.stringify(root)},createWriteStream(${JSON.stringify(join(root,'log'))}),60000);
      process.disconnect();`);
    wrapper = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(wrapper, 'exit');
    for (let i = 0; i < 100; i++) {
      try { pids = JSON.parse(await readFile(ready, 'utf8')); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(pids, 'Check and descendant must have started');
    if (scenario === 'exit') wrapper.send('exit');
    else process.kill(scenario.startsWith('group-') ? -wrapper.pid : wrapper.pid, scenario.replace('group-', ''));
    const [code] = await exited;
    assert.equal(code, scenario === 'exit' ? 7 : scenario === 'SIGTERM' ? 143 : 130);
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    for (let i = 0; i < 100 && (alive(pids.child) || alive(pids.grandchild)); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(pids.child), false, 'Direct check must be gone');
    assert.equal(alive(pids.grandchild), false, 'Inherited-group descendant must be gone');
  });
}

test('normal check completion removes process-level signal handlers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'check-listeners-')); t.after(() => rm(root, { recursive: true, force: true }));
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'];
  const before = names.map(n => process.listenerCount(n));
  await runCheck([process.execPath, '-e', 'console.log("done")'], root, createWriteStream(join(root, 'log')), 2000);
  assert.deepEqual(names.map(n => process.listenerCount(n)), before);
});

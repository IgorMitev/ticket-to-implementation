import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, symlink, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareTicket, configuration, download, request, ticketMarkdown } from '../scripts/prepare-ticket.mjs';
import { extractVideo, run, isAnimatedGif, checkFFmpegVersion } from '../scripts/extract-video.mjs';
import { acquireLock, defaultWorkDir, evidenceSnapshot } from '../scripts/state.mjs';
import { adf, json } from '../scripts/lib.mjs';
import { session } from '../scripts/session.mjs';
import { workflow } from '../scripts/workflow.mjs';

const env = { JIRA_BASE_URL: 'https://jira.example.test', JIRA_EMAIL: 'test@example.test', JIRA_API_TOKEN: 'fixture-secret' };
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const exec = promisify(execFile);
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-skill-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function jiraMock({ attachmentBody = Buffer.from('example'), mime = 'text/plain', filename = '../../notes.txt', failAttachment = false, failComments = false, remoteLinks = [], failRemoteLinks = false } = {}) {
  const calls = [];
  const issue = { key: 'APP-123', names: { customfield_10001: 'Acceptance criteria' }, fields: {
    summary: 'Example feature', description: doc('Add a useful feature'), updated: '2026-11-11T12:00:00Z',
    issuetype: { name: 'Story' }, status: { name: 'Open' }, customfield_10001: doc('It should work'),
    attachment: [{ id: '42', filename, mimeType: mime, size: attachmentBody.length, created: '2026-11-11', content: 'https://untrusted.example/steal' }],
  } };
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from('test@example.test:fixture-secret').toString('base64')}`);
    assert.ok(url.startsWith(env.JIRA_BASE_URL));
    if (url.endsWith('/remotelink')) return failRemoteLinks ? new Response('private', { status: 403 }) : Response.json(remoteLinks);
    if (url.includes('/comment?')) {
      if (failComments) return new Response('private response', { status: 403 });
      const offset = Number(new URL(url).searchParams.get('startAt'));
      return Response.json({ total: 2, comments: [{ id: String(offset + 1), body: doc(`comment ${offset + 1}`), author: { displayName: 'User' } }] });
    }
    if (url.includes('/attachment/content/42')) {
      if (failAttachment) return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/steal' } });
      return new Response(attachmentBody);
    }
    return Response.json(issue);
  };
  return { fetchImpl, calls, issue };
}

test('fetches paginated comments, renders custom fields, sanitizes paths and reuses verified attachments', async t => {
  const out = await temporary(t), mock = jiraMock();
  const first = await prepareTicket('APP-123', { out, fields: 'customfield_10001' }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(first.status, 'complete');
  assert.equal(first.comments_complete, true);
  assert.equal(first.attachments[0].status, 'downloaded');
  assert.ok(first.attachments[0].path.startsWith(join(out, 'attachments') + '/'));
  assert.equal(await readFile(first.attachments[0].path, 'utf8'), 'example');
  const text = await readFile(join(out, 'ticket.md'), 'utf8');
  assert.match(text, /comment 1/); assert.match(text, /comment 2/); assert.match(text, /Acceptance Criteria\nIt should work/);
  const savedProgress = await json(join(out, 'progress.json'));
  savedProgress.notes = 'preserved';
  await writeFile(join(out, 'progress.json'), JSON.stringify(savedProgress));
  const second = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(second.attachments[0].cached, true);
  assert.equal(mock.calls.filter(c => c.includes('/attachment/')).length, 1);
  assert.equal((await json(join(out, 'progress.json'))).notes, 'preserved');
  await writeFile(first.attachments[0].path, 'corrupt');
  mock.issue.fields.description = doc('Changed requirements');
  const third = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(mock.calls.filter(c => c.includes('/attachment/')).length, 2);
  assert.equal(third.snapshot_changed, true);
  await assert.rejects(prepareTicket('APP-124', { out }, { env, fetchImpl: mock.fetchImpl }), /another ticket/);
});

test('reports partial downloads/comments without following redirects or leaking response bodies', async t => {
  const out = await temporary(t), mock = jiraMock({ failAttachment: true, failComments: true });
  const m = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(m.status, 'partial'); assert.equal(m.comments_complete, false);
  assert.equal(m.attachments[0].status, 'failed'); assert.equal(m.errors.length, 2);
  assert.ok(!JSON.stringify(m).includes('fixture-secret'));
  assert.ok(!JSON.stringify(m).includes('private response'));
  assert.ok(mock.calls.every(c => !c.includes('untrusted')));
});

test('enforces stream and aggregate size limits and removes incomplete downloads', async t => {
  const out = await temporary(t);
  await assert.rejects(download(new Response(Buffer.alloc(20)), join(out, 'large'), 10), /exceeds/);
  await assert.rejects(download(new Response('short'), join(out, 'short'), 100, 10), /does not match/);
  await assert.rejects(download(new Response('short', { headers: { 'content-length': '200' } }), join(out, 'declared'), 100), /exceeds size limit/);
  assert.deepEqual(await readdir(out), []);
  const mock = jiraMock({ attachmentBody: Buffer.alloc(2048) });
  const m = await prepareTicket('APP-123', { out, maxTotalMb: 0.001 }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(m.status, 'partial'); assert.match(m.attachments[0].error, /max-total-mb/);
  assert.equal(mock.calls.filter(c => c.includes('/attachment/')).length, 0);
});

test('rejects unsafe configuration and preserves readable ADF links/lists', () => {
  assert.throws(() => configuration({ ...env, JIRA_BASE_URL: 'http://jira.example' }), /HTTPS/);
  assert.throws(() => configuration({ ...env, JIRA_BASE_URL: 'https://user:secret@jira.example' }), /credentials/);
  assert.throws(() => configuration({ ...env, JIRA_BEARER_TOKEN: 'other' }), /not both/);
  const content = { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Example', marks: [{ type: 'link', attrs: { href: 'https://example.test' } }] }] }] }] };
  assert.match(adf(content), /- Example \(https:\/\/example.test\)/);
});

test('prepares real MOV frames, indexed sheets, audio, dense ranges, and reuses cached video evidence', { timeout: 120000 }, async t => {
  const root = await temporary(t), source = join(root, 'sample.mov');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', source]);
  const overview = await extractVideo(source, { out: join(root, 'overview'), audio: true });
  assert.equal(overview.frames.length, 2);
  assert.deepEqual(overview.frames.map(f => f.timestamp_seconds), [0, 2]);
  assert.equal(overview.has_audio, true); assert.equal(overview.audio_file, 'audio.wav');
  const dimensions = async file => JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file])).stdout).streams[0];
  const sheet = await dimensions(join(root, 'overview', overview.contact_sheets[0]));
  assert.equal(sheet.width, 960); assert.equal(sheet.height, 200);
  assert.deepEqual(overview.contact_cells.map(c => [c.row, c.column, c.timestamp_seconds]), [[1, 1, 0], [1, 2, 2]]);
  assert.match(await readFile(join(root, 'overview', overview.contact_index), 'utf8'), /frame-0002.png.*2\.000/);
  const dense = await extractVideo(source, { out: join(root, 'dense'), start: 1, end: 2, interval: 0.1, maxFrames: 20, width: 0 });
  assert.equal(dense.frames.length, 10);
  assert.ok(dense.frames.every(f => f.timestamp_seconds >= 1 && f.timestamp_seconds < 2));
  const frame = await dimensions(join(root, 'dense', dense.frames[0].file));
  assert.equal(frame.width, 640);
  assert.equal(frame.pix_fmt, 'rgb24');
  const fractional = await extractVideo(source, { out: join(root, 'fractional'), start: 1.15, end: 1.55, interval: 0.1 });
  assert.deepEqual(fractional.frames.map(f => f.timestamp_seconds), [1.2, 1.3, 1.4, 1.5]);
  const multi = await extractVideo(source, { out: join(root, 'multi'), interval: 0.2 });
  assert.equal(multi.frames.length, 15);
  assert.equal(multi.contact_sheets.length, 2);
  assert.deepEqual(multi.contact_cells[12], { sheet: 'contact-002.jpg', row: 1, column: 1, file: 'frame-0013.png', timestamp_seconds: 2.4 });
  assert.equal((await dimensions(join(root, 'multi', multi.contact_sheets[1]))).height, 200);
  await assert.rejects(extractVideo(source, { out: join(root, 'overflow'), interval: 0.01, maxFrames: 3 }), /exceeds max-frames/);
  await assert.rejects(extractVideo(source, { out: join(root, 'overview') }), /EEXIST/);
  const mock = jiraMock({ attachmentBody: await readFile(source), mime: 'video/quicktime', filename: 'demo.mov' });
  const out = join(root, 'ticket');
  const first = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(first.status, 'complete'); assert.equal(first.attachments[0].video.frames, 2);
  const second = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(second.attachments[0].video.cached, true);
  await rm(first.attachments[0].video.contact_index);
  const third = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.notEqual(third.attachments[0].video.directory, first.attachments[0].video.directory);
});

test('CLI runs through a symlink, returns fatal and partial exit codes, and emits JSON summaries', async t => {
  const root = await temporary(t), linked = join(root, 'linked-skill');
  await symlink(fileURLToPath(new URL('..', import.meta.url)), linked, 'dir');
  const script = join(linked, 'scripts', 'prepare-ticket.mjs');
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) if (key.startsWith('JIRA_')) delete cleanEnv[key];
  const help = await exec(process.execPath, [script, '--help'], { env: cleanEnv });
  assert.match(help.stdout, /Usage:/);
  await assert.rejects(exec(process.execPath, [script, 'APP-1', '--out', join(root, 'fatal')], { env: cleanEnv }), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /JIRA_BASE_URL/); return true;
  });
  const fixture = join(root, 'fetch-fixture.mjs');
  await writeFile(fixture, `globalThis.fetch = async url => String(url).includes('/comment?') ? new Response('hidden', {status:403}) : String(url).endsWith('/remotelink') ? Response.json([]) : Response.json({key:'APP-1',fields:{summary:'Fixture',attachment:[]}});`);
  await assert.rejects(exec(process.execPath, ['--import', fixture, script, 'app-1', '--out', join(root, 'partial')], { env: { ...cleanEnv, ...env } }), error => {
    assert.equal(error.code, 2);
    const summary = JSON.parse(error.stdout);
    assert.equal(summary.status, 'partial'); assert.equal(summary.errors, 1); assert.match(summary.manifest, /manifest.json$/); return true;
  });
});

test('ticket changes persist until explicitly reconciled, and noisy fields do not bloat context or change the snapshot', async t => {
  const out = await temporary(t), mock = jiraMock();
  mock.issue.names.customfield_10002 = 'Rank';
  mock.issue.fields.customfield_10002 = 'rank-a';
  mock.issue.fields.lastViewed = 'time-a';
  mock.issue.fields.worklog = { worklogs: [{ text: 'verbose worklog' }] };
  const first = await prepareTicket('app-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(first.snapshot_changed, true);
  const progress = await json(join(out, 'progress.json'));
  progress.reconciled_snapshot = first.snapshot_sha256;
  await writeFile(join(out, 'progress.json'), JSON.stringify(progress));
  mock.issue.fields.lastViewed = 'time-b';
  mock.issue.fields.updated = 'new-system-time';
  mock.issue.fields.customfield_10002 = 'rank-b';
  const noise = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(noise.snapshot_changed, false);
  assert.doesNotMatch(await readFile(join(out, 'ticket.md'), 'utf8'), /verbose worklog|lastViewed|rank-b/);
  assert.equal((await json(join(out, 'issue.json'))).fields.lastViewed, 'time-b');
  mock.issue.fields.description = doc('Meaningfully changed');
  const change = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  const rerun = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(change.snapshot_changed, true); assert.equal(rerun.snapshot_changed, true);
  progress.reconciled_snapshot = change.snapshot_sha256;
  await writeFile(join(out, 'progress.json'), JSON.stringify(progress));
  assert.equal((await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl })).snapshot_changed, false);
  const fieldsReordered = { ...mock.issue, fields: Object.fromEntries(Object.entries(mock.issue.fields).reverse()) };
  assert.equal(evidenceSnapshot(mock.issue, [], true), evidenceSnapshot(fieldsReordered, [], true));
});

test('stream downloads can outlast header timeout, but stalled streams are cancelled and cleaned up', async t => {
  const out = await temporary(t);
  const server = createServer((req, res) => {
    res.writeHead(200); res.write('a');
    let count = 0;
    const interval = setInterval(() => { res.write('a'); if (++count === 10) { clearInterval(interval); res.end(); } }, 20);
    res.on('close', () => clearInterval(interval));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const fetchLocal = (_, options) => fetch(`http://127.0.0.1:${server.address().port}`, options);
  const response = await request(configuration(env), 'attachment/content/42', fetchLocal, { attachment: true, timeoutMs: 100 });
  assert.equal((await download(response, join(out, 'slow'), 100, 11, 100)).bytes, 11);
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }));
  await assert.rejects(download(stalled, join(out, 'stalled'), 100, undefined, 30), /stalled/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(out), ['slow']);
});

test('bearer gateway requests and rate-limit errors preserve authentication boundaries', async () => {
  const config = configuration({ JIRA_BASE_URL: env.JIRA_BASE_URL, JIRA_API_BASE_URL: 'https://api.atlassian.com/ex/jira/cloud-id', JIRA_BEARER_TOKEN: 'fixture-bearer' });
  await assert.rejects(request(config, 'issue/APP-1', async (url, options) => {
    assert.equal(url, 'https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/APP-1');
    assert.equal(options.headers.Authorization, 'Bearer fixture-bearer');
    return new Response('secret error body', { status: 429 });
  }), error => { assert.match(error.message, /rate limit/); assert.doesNotMatch(error.message, /secret/); return true; });
});

test('default work directory is deterministic; dead locks recover and active locks remain exclusive', async t => {
  const root = await temporary(t), config = configuration(env);
  assert.equal(defaultWorkDir(config, 'APP-1', root), defaultWorkDir(config, 'APP-1', root));
  assert.notEqual(defaultWorkDir(config, 'APP-1', root), defaultWorkDir({ ...config, api: 'https://api.example.test' }, 'APP-1', root));
  const dir = join(root, 'lock'); await mkdir(dir);
  const child = await exec(process.execPath, ['-e', 'console.log(process.pid)']);
  const deadPid = Number(child.stdout.trim());
  assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
  await writeFile(join(dir, '.prepare.lock'), String(deadPid));
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /active process/);
  await release();
  assert.deepEqual(await readdir(dir), []);
});

test('animated GIFs are reviewed as recordings while static GIFs remain image attachments', async t => {
  const root = await temporary(t), animated = join(root, 'animated.gif'), still = join(root, 'still.gif');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5:duration=2', '-loop', '0', animated]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', animated, '-frames:v', '1', still]);
  assert.equal(await isAnimatedGif(animated), true); assert.equal(await isAnimatedGif(still), false);
  const mock = jiraMock({ attachmentBody: await readFile(animated), mime: 'image/gif', filename: 'capture.gif' });
  const m = await prepareTicket('APP-123', { out: join(root, 'ticket') }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(m.status, 'complete'); assert.equal(m.attachments[0].is_video, true);
  assert.equal(m.attachments[0].video.status, 'prepared');
  assert.ok(m.attachments[0].video.frames >= 2);
});

test('FFmpeg version floor has an actionable error', () => {
  checkFFmpegVersion('ffmpeg version 5.1.6'); checkFFmpegVersion('ffmpeg version 9.0.2');
  assert.throws(() => checkFFmpegVersion('ffmpeg version 4.4.2'), /5.1 or newer/);
});

test('Jira computed fields do not invalidate requirements, while user custom fields do', () => {
  const types = ['com.atlassian.servicedesk:sla-field', 'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf', 'com.atlassian.jira.ext.charting:timeinstatus'];
  const issue = { key: 'APP-1', fields: { summary: 'Example', customfield_10000: 'Actual requirement' }, schema: {} };
  types.forEach((type, i) => { const key = `customfield_${10001 + i}`; issue.schema[key] = { custom: type }; issue.fields[key] = { ongoingCycle: { elapsedTime: 100 }, detail: 'computed-noise' }; });
  const before = evidenceSnapshot(issue, [], true);
  types.forEach((_, i) => { issue.fields[`customfield_${10001 + i}`] = { ongoingCycle: { elapsedTime: 200 }, detail: 'changed-computed-noise' }; });
  assert.equal(evidenceSnapshot(issue, [], true), before);
  assert.doesNotMatch(ticketMarkdown(issue, [], []), /computed-noise/);
  assert.doesNotMatch(ticketMarkdown(issue, [], []), /Actual requirement/);
  issue.fields.customfield_10000 = 'New user requirement';
  assert.notEqual(evidenceSnapshot(issue, [], true), before);
});

test('ADF preserves checkbox states, decisions, ordered criteria, status, dates and expand titles', () => {
  const text = value => ({ type: 'text', text: value });
  const rendered = adf({ type: 'doc', content: [
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [text('Export button visible')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('CSV includes headers')] }] },
    { type: 'decisionList', content: [{ type: 'decisionItem', attrs: { state: 'DECIDED' }, content: [text('Use CSV')] }] },
    { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [doc('Third criterion').content[0]] }, { type: 'listItem', content: [doc('Fourth criterion').content[0]] }] },
    { type: 'paragraph', content: [{ type: 'status', attrs: { text: 'BLOCKED' } }, text(' until '), { type: 'date', attrs: { timestamp: String(Date.UTC(2026, 10, 11)) } }] },
    { type: 'expand', attrs: { title: 'Edge cases' }, content: [doc('Missing headers').content[0]] },
  ] });
  assert.match(rendered, /- \[x\] Export button visible\n- \[ \] CSV includes headers/);
  assert.match(rendered, /Decision \(DECIDED\): Use CSV/);
  assert.match(rendered, /3\. Third criterion\n4\. Fourth criterion/);
  assert.match(rendered, /\[BLOCKED\] until 2026-11-11/);
  assert.match(rendered, /Edge cases\nMissing headers/);
  assert.match(ticketMarkdown({ key: 'APP-1', names: { customfield_10000: 'Environment(s)' }, fields: { customfield_10000: { value: 'Parent', child: { value: 'Child' } } } }, [], []), /Parent → Child/);
});

test('remote links are fetched as references, affect the snapshot and surface failures', async t => {
  const root = await temporary(t), links = [{ id: 1, object: { title: 'Figma design', url: 'https://design.example.test/one' } }];
  const mock = jiraMock({ remoteLinks: links });
  const out = join(root, 'good');
  const first = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(first.remote_links_complete, true);
  assert.match(await readFile(join(out, 'ticket.md'), 'utf8'), /Figma design: https:\/\/design.example.test\/one/);
  assert.deepEqual(await json(join(out, 'remote-links.json')), links);
  const progress = await json(join(out, 'progress.json')); progress.reconciled_snapshot = first.snapshot_sha256;
  await writeFile(join(out, 'progress.json'), JSON.stringify(progress));
  links[0].object.url = 'https://design.example.test/two';
  const changed = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(changed.snapshot_changed, true);
  assert.ok(mock.calls.every(url => url.startsWith(env.JIRA_BASE_URL)));
  const failed = jiraMock({ failRemoteLinks: true });
  const partial = await prepareTicket('APP-123', { out: join(root, 'failed') }, { env, fetchImpl: failed.fetchImpl });
  assert.equal(partial.status, 'partial'); assert.equal(partial.remote_links_complete, false);
  assert.equal(partial.errors[0].stage, 'remote-links');
});

test('MPEG-TS detail passes recover evidence before the next keyframe', { timeout: 120000 }, async t => {
  const root = await temporary(t), source = join(root, 'recording.ts');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=9', '-c:v', 'mpeg2video', '-g', '75', '-sc_threshold', '1000000000', '-f', 'mpegts', source]);
  const wide = await extractVideo(source, { out: join(root, 'wide'), start: 3.37, end: 7, interval: 0.5 });
  assert.ok(wide.frames.length >= 7);
  assert.ok(wide.coverage.first_frame_seconds < 3.9);
  assert.equal(wide.coverage.start_gap_exceeds_sampling, false);
  const narrow = await extractVideo(source, { out: join(root, 'narrow'), start: 3.37, end: 4.2, interval: 0.1 });
  assert.ok(narrow.frames.length >= 7);
  assert.ok(narrow.frames.every(f => f.timestamp_seconds >= 3.37 && f.timestamp_seconds < 4.2));
});

test('live WebM without duration metadata derives its duration from packets', { timeout: 120000 }, async t => {
  const root = await temporary(t), source = join(root, 'live.webm');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2.5', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-live', '1', source]);
  const m = await extractVideo(source, { out: join(root, 'evidence') });
  assert.equal(m.duration_source, 'video_packet_scan');
  assert.ok(Math.abs(m.duration_seconds - 2.5) < 0.02);
  assert.ok(m.frames.length >= 2);
  assert.equal(m.extracted_width, 160); assert.equal(m.extracted_height, 90);
});

test('continue preserves progress; reset archives state and isolates new findings without deleting evidence or code', async t => {
  const out = await temporary(t), mock = jiraMock();
  const manifest = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  const progressPath = join(out, 'progress.json');
  const progress = await json(progressPath);
  progress.reconciled_snapshot = manifest.snapshot_sha256;
  progress.user_scope = 'Review only; do not implement.';
  progress.next_action = 'Ask about the empty state.';
  const oldBrief = join(progress.artifact_directory, 'agreed-requirements.md');
  await writeFile(oldBrief, 'Old requirements');
  await writeFile(join(out, 'example-source.txt'), 'Existing code changes');
  await writeFile(progressPath, JSON.stringify(progress));
  const before = await readFile(progressPath, 'utf8');
  const continued = await session('continue', 'app-123', { out }, { env: {} });
  assert.equal(continued.snapshot_changed, false);
  assert.equal(continued.phases.investigation, 'pending');
  assert.equal((await json(progressPath)).reconciled_snapshot, JSON.parse(before).reconciled_snapshot);
  const reset = await session('reset', 'APP-123', { out }, { env: {} });
  assert.equal(reset.snapshot_changed, true);
  assert.ok(Object.values(reset.phases).every(status => status === 'pending'));
  assert.notEqual(reset.artifact_directory, progress.artifact_directory);
  assert.deepEqual(await readdir(reset.artifact_directory), []);
  assert.equal((await json(reset.archive)).progress.reconciled_snapshot, manifest.snapshot_sha256);
  assert.equal((await json(progressPath)).user_scope, progress.user_scope);
  assert.equal(await readFile(oldBrief, 'utf8'), 'Old requirements');
  assert.equal(await readFile(join(out, 'example-source.txt'), 'utf8'), 'Existing code changes');
  assert.equal(await readFile(manifest.attachments[0].path, 'utf8'), 'example');
  const after = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(after.attachments[0].cached, true);
  assert.equal((await json(progressPath)).artifact_directory, reset.artifact_directory);
  await assert.rejects(session('reset', 'APP-999', { out }, { env: {} }), /another ticket/);
  const cli = await exec(process.execPath, [fileURLToPath(new URL('../scripts/session.mjs', import.meta.url)), 'continue', 'APP-123', '--out', out]);
  assert.equal(JSON.parse(cli.stdout).artifact_directory, reset.artifact_directory);
});

test('ticket preparation invalidates accepted workflow phases when fetched requirements change', async t => {
  const out = await temporary(t), mock = jiraMock();
  await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  const draft = join(out, 'input.json');
  await writeFile(draft, JSON.stringify({ kind: 'feature', scope: 'implement', user_request: 'Implement this feature', repository: await temporary(t) }));
  await workflow('configure', 'APP-123', { out, input: draft }, { env: {} });
  const start = await workflow('start', 'APP-123', { out, phase: 'evidence_review' }, { env: {} });
  const report = join(start.artifact_directory, 'evidence.md'); await writeFile(report, 'Read the ticket and its attachment.');
  await writeFile(draft, JSON.stringify({ phase_token: start.phase_token, summary: 'Evidence reviewed', artifacts: [report], attachments: [{ id: '42', disposition: 'reviewed' }], no_video_reason: 'Only a text attachment' }));
  await workflow('complete', 'APP-123', { out, phase: 'evidence_review', input: draft }, { env: {} });
  await workflow('start', 'APP-123', { out, phase: 'investigation' }, { env: {} });
  mock.issue.fields.description = doc('New requirements from Jira');
  const updated = await prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  assert.equal(updated.snapshot_changed, true);
  const progress = await json(join(out, 'progress.json'));
  assert.equal(progress.phases.evidence_review.status, 'pending');
  assert.equal(progress.phases.investigation.status, 'pending');
  assert.ok(progress.events.some(e => e.action === 'invalidate' && e.invalidated.length));
});

test('complete snapshots survive partial refresh and later reconcile actual changes', async t => {
  const out = await temporary(t), good = jiraMock(), bad = jiraMock({ failComments: true });
  await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  const draft = join(out, 'draft.json');
  const call = async (action, phase, data) => {
    if (data) await writeFile(draft, JSON.stringify(data));
    return workflow(action, 'APP-123', { out, phase, ...(data ? { input: draft } : {}) }, { env: {} });
  };
  await call('configure', undefined, { kind: 'feature', scope: 'implement', repository: await temporary(t), user_request: 'Implement ticket' });
  for (const phase of ['evidence_review', 'investigation', 'clarification']) {
    const s = await call('start', phase);
    const artifact = join(s.artifact_directory, phase + '.md'); await writeFile(artifact, 'Reviewed evidence');
    const report = { phase_token: s.phase_token, summary: phase, artifacts: [artifact],
      ...(phase === 'evidence_review' ? { attachments: [{ id: '42', disposition: 'reviewed' }], no_video_reason: 'None' } :
        phase === 'investigation' ? { current_behavior: 'Missing', relevant_files: [], feature_analysis: 'Add feature', constraints: [] } :
          { acceptance_criteria: [{ id: 'AC1', requirement: 'Feature works', verification: 'Test it' }], scope_exclusions: [], questions: [] }),
    };
    if (phase === 'clarification') {
      const presented = await call('present', phase, report);
      report.alignment = { status: 'confirmed_by_user', proposal_id: presented.proposal.id, user_response: 'Approved', rationale: 'User approved summary' };
    }
    await call('complete', phase, report);
  }
  const before = await json(join(out, 'progress.json'));
  const ticket = await readFile(join(out, 'ticket.md'), 'utf8');
  const partial = await prepareTicket('APP-123', { out }, { env, fetchImpl: bad.fetchImpl });
  assert.equal(partial.status, 'partial'); assert.ok(partial.refresh_warning);
  assert.equal(await readFile(join(out, 'ticket.md'), 'utf8'), ticket);
  assert.deepEqual((await json(join(out, 'progress.json'))).phases, before.phases);
  const recovered = await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  assert.equal(recovered.refresh_warning, undefined);
  assert.deepEqual((await json(join(out, 'progress.json'))).phases, before.phases);
  good.issue.fields.summary = 'Changed requirement';
  await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  assert.equal((await json(join(out, 'progress.json'))).phases.clarification.status, 'pending');
});

test('permanent attachment failures adopt fresh content and explicit partial acceptance unfreezes missing links', async t => {
  const out = await temporary(t), good = jiraMock();
  await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  good.issue.fields.description = doc('New requirement despite oversized evidence');
  good.issue.fields.attachment.push({ id: '43', filename: 'huge.mov', mimeType: 'video/quicktime', size: 900 * 1024 * 1024 });
  const partial = await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  assert.equal(partial.status, 'partial'); assert.equal(partial.refresh_warning, undefined);
  assert.match(await readFile(join(out, 'ticket.md'), 'utf8'), /New requirement despite oversized evidence/);

  const other = await temporary(t), base = jiraMock(), failed = jiraMock({ failRemoteLinks: true });
  await prepareTicket('APP-123', { out: other }, { env, fetchImpl: base.fetchImpl });
  failed.issue.fields.description = doc('New requirement despite inaccessible links');
  const retained = await prepareTicket('APP-123', { out: other }, { env, fetchImpl: failed.fetchImpl });
  assert.ok(retained.refresh_warning);
  const adopted = await prepareTicket('APP-123', { out: other, acceptPartial: true }, { env, fetchImpl: failed.fetchImpl });
  assert.equal(adopted.status, 'partial'); assert.equal(adopted.refresh_warning, undefined);
  assert.match(await readFile(join(other, 'ticket.md'), 'utf8'), /New requirement despite inaccessible links/);
  assert.ok(adopted.errors.some(e => e.stage === 'remote-links'));
});

test('preparation retries contention and CLI reports busy as exit 3', async t => {
  const out = await temporary(t), mock = jiraMock();
  const release = await acquireLock(out);
  const pending = prepareTicket('APP-123', { out }, { env, fetchImpl: mock.fetchImpl });
  await new Promise(resolve => setTimeout(resolve, 150)); await release();
  assert.equal((await pending).status, 'complete');
  const held = await acquireLock(out);
  try {
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../scripts/prepare-ticket.mjs', import.meta.url)), 'APP-123', '--out', out], { env: { ...process.env, ...env } }), error => error.code === 3 && /LOCK_BUSY/.test(error.stderr));
  } finally { await held(); }
});

for (const unavailable of ['comments', 'remote-links']) {
test('approved attachment-partial snapshot survives transient failure: ' + unavailable, async t => {
  const out = await temporary(t), good = jiraMock(), bad = jiraMock(unavailable === 'comments' ? { failComments: true } : { failRemoteLinks: true });
  for (const mock of [good, bad]) mock.issue.fields.attachment.push({ id: '43', filename: 'huge.mov', mimeType: 'video/quicktime', size: 900 * 1024 * 1024 });
  const initial = await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  assert.equal(initial.status, 'partial'); assert.equal(initial.comments_complete, true);
  const draft = join(out, 'draft.json');
  const call = async (action, phase, data) => {
    if (data) await writeFile(draft, JSON.stringify(data));
    return workflow(action, 'APP-123', { out, phase, ...(data ? { input: draft } : {}) }, { env: {} });
  };
  await call('configure', undefined, { kind: 'feature', scope: 'implement', repository: await temporary(t), user_request: 'Implement ticket' });
  for (const phase of ['evidence_review', 'investigation', 'clarification']) {
    const s = await call('start', phase);
    const artifact = join(s.artifact_directory, phase + '.md'); await writeFile(artifact, 'Reviewed evidence');
    const report = { phase_token: s.phase_token, summary: phase, artifacts: [artifact],
      ...(phase === 'evidence_review' ? { attachments: [{ id: '42', disposition: 'reviewed' }, { id: '43', disposition: 'unavailable', reason: 'Oversized recording' }], no_video_reason: 'No downloadable video', exceptions: [{ code: 'missing_evidence', reason: 'Oversized recording' }] } :
        phase === 'investigation' ? { current_behavior: 'Missing', relevant_files: [], feature_analysis: 'Add feature', constraints: [] } :
          { acceptance_criteria: [{ id: 'AC1', requirement: 'Feature works', verification: 'Test it' }], scope_exclusions: [], questions: [], exception_decisions: [{ phase: 'evidence_review', code: 'missing_evidence', resolution: 'accepted_by_user', reason: 'Proceed using the description', user_response: 'Proceed without the oversized recording' }] }),
    };
    if (phase === 'clarification') {
      const presented = await call('present', phase, report);
      report.alignment = { status: 'confirmed_by_user', proposal_id: presented.proposal.id, user_response: 'Approved', rationale: 'User approved summary' };
    }
    await call('complete', phase, report);
  }
  const before = await json(join(out, 'progress.json'));
  const ticket = await readFile(join(out, 'ticket.md'), 'utf8');
  const partial = await prepareTicket('APP-123', { out }, { env, fetchImpl: bad.fetchImpl });
  assert.equal(partial.status, 'partial'); assert.ok(partial.refresh_warning);
  assert.equal(await readFile(join(out, 'ticket.md'), 'utf8'), ticket);
  assert.deepEqual((await json(join(out, 'progress.json'))).phases, before.phases);
  const recovered = await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  assert.equal(recovered.refresh_warning, undefined); assert.equal(recovered.status, 'partial');
  assert.deepEqual((await json(join(out, 'progress.json'))).phases, before.phases);
  good.issue.fields.summary = 'Changed requirement';
  await prepareTicket('APP-123', { out }, { env, fetchImpl: good.fetchImpl });
  assert.equal((await json(join(out, 'progress.json'))).phases.clarification.status, 'pending');
});

}


test('engineering projection keeps populated allowlisted fields and drops unrelated custom fields and empty sections', () => {
  const names = { customfield_1: 'Severity', customfield_2: 'Acceptance Criteria',
    customfield_3: 'Environment(s)', customfield_4: 'Steps to Reproduce',
    customfield_5: 'Expected Result', customfield_6: 'Actual Result', customfield_7: 'Epic Link',
    customfield_8: 'Budget', customfield_9: 'AWS', customfield_10: 'requestLine_purchaseOrder',
    customfield_11: 'Purchase-order', customfield_12: 'Acceptance criteria notes' };
  const fields = { summary: 'Sample', issuetype: {name: 'Bug'}, status: {name: 'Open'}, priority: {name: 'High'},
    description: doc('Details'), components: [{name: 'Editor'}], labels: ['regression'],
    versions: [{name: 'v1'}], fixVersions: [{name: 'v2'}], parent: {key: 'APP-2'}, subtasks: [{key: 'APP-3'}],
    customfield_1: 'Critical', customfield_2: doc('Works'), customfield_3: 'QA', customfield_4: 'Click',
    customfield_5: 'Closes', customfield_6: 'Stays open', customfield_7: 'APP-4',
    customfield_8: 'secret-budget', customfield_9: 'secret-aws', customfield_10: 'secret-request',
    customfield_11: 'secret-order', customfield_12: 'secret-notes', customfield_99: 'secret-unknown',
    assignee: {displayName:'secret-assignee'}, updated: 'secret-timestamp', project: {name:'secret-project'},
    issuelinks: [{type: {outward: 'blocks'}, outwardIssue: {key: 'APP-5'}}] };
  const text = ticketMarkdown({key: 'APP-1', names, fields}, [{id:'1', body:doc('Discussion')}],
    [{id:'1', filename:'evidence.png', mime_type:'image/png', size:100, status:'downloaded'}], {},
    [{object: {title:'Spec', url:'https://example.test/spec'}}]);
  for (const expected of ['APP-1: Sample', 'Issue Type', 'Bug', 'Status', 'Open', 'Priority', 'High',
    'Severity', 'Critical', 'Description', 'Details', 'Acceptance Criteria', 'Works', 'Environment(s)', 'QA',
    'Steps to Reproduce', 'Click', 'Expected Result', 'Closes', 'Actual Result', 'Stays open', 'Components',
    'Editor', 'Labels', 'regression', 'Affects versions', 'v1', 'Fix versions', 'v2', 'Parent/Epic Link',
    'APP-2', 'APP-4', 'Sub-tasks', 'APP-3', 'Linked issues', 'APP-5', 'External links', 'Spec',
    'Comments', 'Discussion', 'Attachments', 'evidence.png']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /secret-|customfield_|Updated:/);
  const empty = ticketMarkdown({key: 'APP-1', names, fields: {summary:' ', description:doc(' '), labels:[],
    components:[{}], customfield_1:null, customfield_2:doc(''), customfield_3:'', customfield_4:{}}},
    [{body:doc('')}], [], {}, [{object:{title:'No URL'}}]);
  assert.equal(empty.trim(), '# APP-1');
});

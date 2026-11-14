import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { checkDevServer, serverTarget } from '../scripts/check-dev-server.mjs';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `${server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}

test('reachability requires explicit base details and confines routes to that origin', () => {
  for (const base of [undefined, 'localhost:123', 'http://localhost', 'https://example.test/path',
    'http://user:pass@example.test:123', 'http://example.test:12?token=x'])
    assert.throws(() => serverTarget(base, '/ok'));
  for (const route of [undefined, 'ok', '//other.test/path', '/\\other.test/x', '/ok#fragment'])
    assert.throws(() => serverTarget('http://example.test:123', route));
  assert.equal(serverTarget('https://example.test:443', '/ok?q=1').href, 'https://example.test/ok?q=1');
  assert.equal(serverTarget('http://[::1]:123', '/ok').hostname, '[::1]');
});

test('reachability accepts only 200, does not follow redirects, times out and detects server loss', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === '/hang') return;
    res.writeHead(req.url === '/ok' ? 200 : req.url === '/redirect' ? 302 : 503, {location:'/ok'});
    res.end('body is not retained');
  });
  const base = await listen(t, server);
  assert.equal((await checkDevServer(base, '/ok')).reachable, true);
  assert.equal((await checkDevServer(base, '/redirect')).status, 302);
  assert.deepEqual(seen, ['/ok', '/redirect']);
  assert.equal((await checkDevServer(base, '/down')).reachable, false);
  await assert.rejects(checkDevServer(base, '/hang', {timeoutMs:20}), /timed out/);
  await assert.rejects(checkDevServer(base, '/ok', {timeoutMs:NaN}), /timeoutMs/);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(checkDevServer(base, '/ok'));
});

test('certificate bypass is per-request and supports a self-signed user server', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ticket-server-tls-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir,'key.pem'),
      '-out', join(dir,'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], {stdio:'ignore'});
  } catch { t.skip('OpenSSL required to generate a self-signed fixture'); return; }
  const base = await listen(t, https.createServer({key:await readFile(join(dir,'key.pem')),
    cert:await readFile(join(dir,'cert.pem'))}, (_, res) => res.end('ok')));
  await assert.rejects(checkDevServer(base, '/ok'));
  const result = await checkDevServer(base, '/ok', {insecure:true});
  assert.equal(result.reachable, true);
  assert.equal(result.certificate_verification, false);
  await assert.rejects(checkDevServer(base, '/ok'));
});

async function browser() {
  class XHR {
    constructor() { this.readyState = 0; this.status = 200; this.responseType = ''; }
    open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
    send() { this.readyState = 4; }
    get responseText() { if (this.responseType === 'json') throw new Error('InvalidStateError'); return 'original'; }
    get response() { return this.responseType === 'json' ? {original:true} : 'original'; }
  }
  const original = Object.getOwnPropertyDescriptors(XHR.prototype);
  const context = vm.createContext({XMLHttpRequest:XHR, URL, document:{baseURI:'https://app.test/editor'}});
  vm.runInContext(await readFile(new URL('../scripts/xhr-response-override.js', import.meta.url), 'utf8'), context);
  return {XHR, original, context, api:context.__ticketXHR};
}

test('XHR override scopes actual GET response getters, supports text/json and restores descriptors', async () => {
  const {XHR, original, context, api} = await browser();
  assert.equal(api.status().active, false);
  api.install({url:'https://app.test/api/items?state=bad', body:{items:[]}});
  assert.throws(() => api.install({url:'https://app.test/other', body:{}}), /Remove/);
  const request = (method, url, type = '') => {
    const xhr = new XHR(); xhr.responseType = type; xhr.open(method, url); xhr.send(); return xhr;
  };
  const a = request('GET', '/api/items?state=bad');
  assert.equal(a.responseText, '{"items":[]}');
  assert.equal(a.response, '{"items":[]}');
  const b = request('get', '/api/items?state=bad', 'json');
  assert.equal(JSON.stringify(b.response), '{"items":[]}');
  assert.throws(() => b.responseText, /InvalidStateError/);
  assert.equal(api.status().matched_responses, 2);
  for (const [method, url] of [['POST','/api/items?state=bad'], ['GET','/api/items?state=good'],
    ['GET','https://other.test/api/items?state=bad']]) assert.equal(request(method,url).response, 'original');
  a.open('GET', '/other'); a.send(); assert.equal(a.response, 'original');
  const failed = new XHR(); failed.status=500; failed.open('GET','/api/items?state=bad'); failed.send();
  assert.equal(failed.responseText, 'original');
  assert.equal(request('GET','/api/items?state=bad','blob').response, 'original');
  const pending = new XHR(); pending.open('GET','/api/items?state=bad');
  assert.equal(pending.response, 'original');
  assert.equal(api.remove().active, false);
  assert.equal(context.__ticketXHR, undefined);
  assert.deepEqual(Object.getOwnPropertyDescriptors(XHR.prototype), original);
  assert.equal(b.response.original, true);
  assert.equal(api.remove().active, false);
});

test('XHR helper validates fixture before patching and refuses incompatible descriptors', async () => {
  const {XHR, original, api} = await browser();
  assert.throws(() => api.install({url:'/relative',body:{}}));
  assert.throws(() => api.install({url:'https://app.test/x',body:undefined}));
  assert.deepEqual(Object.getOwnPropertyDescriptors(XHR.prototype), original);
  Object.defineProperty(XHR.prototype,'send',{configurable:false});
  assert.throws(() => api.install({url:'https://app.test/x',body:{}}), /safely/);
  assert.equal(api.status().active, false);
  api.remove();
});

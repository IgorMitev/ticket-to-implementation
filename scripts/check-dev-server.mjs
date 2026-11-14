import http from 'node:http';
import https from 'node:https';
import { args, isMain } from './lib.mjs';

export function serverTarget(base, route) {
  // Require an explicit authority port even when URL normalizes a default port away.
  if (typeof base !== 'string' || !/^https?:\/\/(?:\[[^\]]+\]|[^/:?#@]+):\d+\/?$/.test(base))
    throw new Error('Supply the base URL with explicit scheme, host and port, without credentials, path, query or fragment');
  const url = new URL(base);
  if (!url.hostname) throw new Error('Base URL needs a host');
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//'))
    throw new Error('Supply a known-good route beginning with /');
  const target = new URL(route, url);
  if (target.origin !== url.origin || target.hash || target.username || target.password)
    throw new Error('Route must stay on the supplied origin and have no fragment or credentials');
  return target;
}

export async function checkDevServer(base, route, { insecure = false, timeoutMs = 10000 } = {}) {
  const target = serverTarget(base, route);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('timeoutMs must be an integer between 1 and 60000');
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? https : http).get(target, {
      rejectUnauthorized: !insecure,
    }, response => {
      clearTimeout(timer);
      const status = response.statusCode;
      response.destroy();
      resolve({ reachable: status === 200, status, url: target.href,
        certificate_verification: target.protocol === 'https:' ? !insecure : null });
    });
    const timer = setTimeout(() => request.destroy(new Error('Reachability check timed out')), timeoutMs);
    request.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

if (isMain(import.meta.url)) {
  try {
    const { values } = args({ 'base-url': { type: 'string' }, route: { type: 'string' },
      insecure: { type: 'boolean' }, 'timeout-ms': { type: 'string' } });
    if (values.help) console.log('Usage: node check-dev-server.mjs --base-url USER_BASE_URL --route /KNOWN_GOOD_ROUTE [--insecure] [--timeout-ms 10000]');
    else {
      const result = await checkDevServer(values['base-url'], values.route, {
        insecure: values.insecure, timeoutMs: values['timeout-ms'] === undefined ? 10000 : Number(values['timeout-ms']),
      });
      console.log(JSON.stringify(result));
      if (!result.reachable) process.exitCode = 2;
    }
  } catch (error) { console.error(JSON.stringify({ reachable: false, error: error.message })); process.exitCode = 2; }
}

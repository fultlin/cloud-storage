import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const base = new URL(process.env.FULL_STACK_BASE_URL ?? 'http://127.0.0.1:8080');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
  base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
  throw new Error('FULL_STACK_BASE_URL must be a local HTTP origin');
}

function request(path, options = {}, timeout = 10_000) {
  return fetch(new URL(path, base), { ...options, redirect: 'error', signal: AbortSignal.timeout(timeout) });
}

const readiness = await request('/api/user/me');
assert.equal(readiness.status, 401, 'Expected an unauthenticated response through nginx');
assert.match(readiness.headers.get('server') ?? '', /^nginx(?:\/|$)/, 'Expected the nginx entry point');
await readiness.body?.cancel();

const username = `nginx_${randomBytes(6).toString('hex')}`;
const registration = await request('/api/auth/sign-up', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password: randomBytes(24).toString('hex') }),
});
assert.equal(registration.status, 201, await registration.text());
const cookie = registration.headers.getSetCookie().find(value => value.startsWith('sid='))?.split(';')[0];
assert.ok(cookie, 'Registration must set a session cookie');

const name = 'nginx-verification.bin';
const bytes = 1024 ** 3;
const boundary = `cloud-storage-${randomBytes(12).toString('hex')}`;
const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
const input = createHash('sha256');
const output = createHash('sha256');
const began = performance.now();

try {
  console.info('Uploading 1 GiB through nginx');
  const source = Readable.from((function* () {
    yield head;
    for (let index = 0; index < 1024; index++) {
      const part = Buffer.alloc(1024 ** 2, index % 251);
      input.update(part);
      yield part;
    }
    yield tail;
  })(), { objectMode: false });
  const uploaded = await request('/api/resource?path=', {
    method: 'POST', duplex: 'half', body: Readable.toWeb(source),
    headers: {
      Cookie: cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(head.length + bytes + tail.length),
    },
  }, 600_000);
  const result = await uploaded.text();
  assert.equal(uploaded.status, 201, result);
  assert.deepEqual(JSON.parse(result), [{ path: '', name, size: bytes, type: 'FILE' }]);

  console.info('Downloading 1 GiB through nginx');
  const downloaded = await request(`/api/resource/download?${new URLSearchParams({ path: name })}`,
    { headers: { Cookie: cookie } }, 600_000);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.ok(downloaded.body);
  let received = 0;
  for await (const part of downloaded.body) {
    output.update(part);
    received += part.byteLength;
  }
  assert.equal(received, bytes);
  const sha256 = input.digest('hex');
  assert.equal(output.digest('hex'), sha256);
  console.info(JSON.stringify({ bytes, sha256, elapsedSeconds: (performance.now() - began) / 1000 }));
} finally {
  try {
    const removed = await request(`/api/resource?${new URLSearchParams({ path: name })}`, { method: 'DELETE', headers: { Cookie: cookie } });
    if (![204, 404].includes(removed.status)) console.warn(`Could not remove the test file: HTTP ${removed.status}`);
    await removed.body?.cancel();
  } catch { console.warn('Could not remove the test file'); }
  try {
    const logout = await request('/api/auth/sign-out', { method: 'POST', headers: { Cookie: cookie } });
    await logout.body?.cancel();
  } catch { console.warn('Could not close the test session'); }
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';

const root = new URL('../../../', import.meta.url);
const apiRoot = new URL('../', import.meta.url);
const example = parseEnv(await readFile(new URL('.env.example', root), 'utf8'));
const bytes = 2 * 1024 ** 3;
const containers = [];
let child;
let peakRss = 0;
let latestRss = 0;
let baselineRss;

function http(port, method, path, headers = {}) {
  const outgoing = request({ host: '127.0.0.1', port, method, path, headers });
  outgoing.setTimeout(600_000, () => outgoing.destroy(new Error('HTTP verification timed out')));
  const response = new Promise((resolve, reject) => {
    outgoing.once('response', resolve);
    outgoing.once('error', reject);
  });
  return { outgoing, response };
}

async function run(command, args, env) {
  const process = spawn(command, args, { cwd: fileURLToPath(apiRoot), env, windowsHide: true, stdio: 'inherit' });
  const [code] = await once(process, 'exit');
  assert.equal(code, 0, 'Subprocess must succeed');
}

try {
  console.info('Starting isolated PostgreSQL, Redis and SeaweedFS');
  const postgres = await new PostgreSqlContainer('postgres:18.0-alpine').start();
  containers.push(postgres);
  const redis = await new GenericContainer('redis:8.2.2-alpine').withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections')).start();
  containers.push(redis);
  const seaweed = await new GenericContainer('chrislusf/seaweedfs:4.48')
    .withEnvironment({ AWS_ACCESS_KEY_ID: example.S3_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: example.S3_SECRET_ACCESS_KEY })
    .withExposedPorts(8333)
    .withCommand(['server', '-dir=/data', '-ip=127.0.0.1', '-ip.bind=0.0.0.0', '-volume.max=5', '-master.volumeSizeLimitMB=1024', '-filer', '-s3'])
    .withWaitStrategy(Wait.forLogMessage('Start Seaweed S3 API Server')).start();
  containers.push(seaweed);
  const bucket = await seaweed.exec(['sh', '-c', "printf 's3.bucket.create -name user-files\\n' | weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888"]);
  assert.equal(bucket.exitCode, 0);

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const env = {
    ...process.env, ...example, NODE_ENV: 'test', PORT: String(port), SWAGGER_ENABLED: 'false',
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    S3_ENDPOINT: `http://${seaweed.getHost()}:${seaweed.getMappedPort(8333)}`,
    UPLOAD_MAX_FILE_SIZE_BYTES: String(bytes),
  };
  await run(process.execPath, [fileURLToPath(new URL('node_modules/prisma/build/index.js', apiRoot)), 'migrate', 'deploy', '--config', 'prisma.config.ts'], env);

  const main = new URL('dist/main.js', apiRoot).href;
  child = spawn(process.execPath, ['--input-type=module', '-e',
    `setInterval(() => process.send?.({ rss: process.memoryUsage().rss }), 100).unref(); await import(${JSON.stringify(main)});`],
  { cwd: fileURLToPath(root), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // No environment values or session cookies are written to the verification report.
  child.on('message', message => {
    latestRss = message.rss;
    if (baselineRss !== undefined) peakRss = Math.max(peakRss, latestRss);
  });
  child.stdout.resume();
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`API failed to start: ${diagnostics}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/user/me`);
      ready = response.status === 401;
      await response.body?.cancel();
      if (ready && latestRss) break;
    } catch { /* Wait for the socket to bind. */ }
    await delay(100);
  }
  assert.ok(ready && latestRss, 'API must become ready and report memory');
  const signup = await fetch(`http://127.0.0.1:${port}/api/auth/sign-up`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'large_http_test', password: 'verification-password' }),
  });
  assert.equal(signup.status, 201);
  const cookie = signup.headers.getSetCookie()[0].split(';')[0];
  await signup.body?.cancel();
  baselineRss = latestRss;
  peakRss = baselineRss;
  const started = Date.now();
  const inputHash = createHash('sha256');
  const outputHash = createHash('sha256');
  const boundary = 'cloud-storage-large-verification';
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const upload = http(port, 'POST', '/api/resource?path=', {
    Cookie: cookie, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': String(Buffer.byteLength(header) + bytes + Buffer.byteLength(footer)),
  });
  console.info('Uploading 2 GiB through HTTP');
  const source = Readable.from((function* () {
    yield header;
    for (let index = 0; index < 2048; index++) {
      const chunk = Buffer.alloc(1024 ** 2, index % 251);
      inputHash.update(chunk);
      yield chunk;
    }
    yield footer;
  })(), { objectMode: false });
  const [, uploaded] = await Promise.all([pipeline(source, upload.outgoing), upload.response]);
  assert.equal(uploaded.statusCode, 201, await text(uploaded));
  console.info('Downloading 2 GiB through HTTP');
  const download = http(port, 'GET', '/api/resource/download?path=large.bin', { Cookie: cookie });
  download.outgoing.end();
  const response = await download.response;
  assert.equal(response.statusCode, 200);
  let downloaded = 0;
  await pipeline(response, new Writable({ write(chunk, _encoding, callback) {
    downloaded += chunk.length;
    outputHash.update(chunk);
    callback();
  } }));
  assert.equal(downloaded, bytes);
  const hash = inputHash.digest('hex');
  assert.equal(outputHash.digest('hex'), hash);
  const growth = peakRss - baselineRss;
  assert.ok(growth < 512 * 1024 ** 2, `API RSS grew by ${growth} bytes`);
  const report = {
    verifiedAt: new Date().toISOString(), node: process.version, seaweed: '4.48', bytes, sha256: hash,
    apiBaselineRss: baselineRss, apiPeakRss: peakRss, apiRssGrowth: growth,
    elapsedSeconds: (Date.now() - started) / 1000, transport: 'HTTP multipart upload and HTTP streaming download',
    isolatedContainers: true, nginx: false,
  };
  const reportDirectory = new URL('verification/', apiRoot);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(new URL('large-http.json', reportDirectory), JSON.stringify(report, null, 2) + '\n');
  console.info(JSON.stringify(report, null, 2));
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
  await Promise.allSettled(containers.reverse().map(container => container.stop()));
}

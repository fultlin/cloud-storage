import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait } from 'testcontainers';

const apiRoot = new URL('../', import.meta.url);
const webRoot = new URL('../../web/', import.meta.url);
const root = new URL('../../../', import.meta.url);
const example = parseEnv(await readFile(new URL('.env.example', root), 'utf8'));
const containers = [];
let api;
async function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd: fileURLToPath(cwd), env, windowsHide: true, stdio: 'inherit' });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'Verification subprocess failed');
}
try {
  console.info('Starting isolated services for browser verification');
  const postgres = await new PostgreSqlContainer('postgres:18.0-alpine').start(); containers.push(postgres);
  const redis = await new GenericContainer('redis:8.2.2-alpine').withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections')).start(); containers.push(redis);
  const seaweed = await new GenericContainer('chrislusf/seaweedfs:4.48')
    .withEnvironment({ AWS_ACCESS_KEY_ID: example.S3_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: example.S3_SECRET_ACCESS_KEY })
    .withExposedPorts(8333).withCommand(['server', '-dir=/data', '-ip=127.0.0.1', '-ip.bind=0.0.0.0', '-volume.max=5', '-master.volumeSizeLimitMB=1024', '-filer', '-s3'])
    .withWaitStrategy(Wait.forLogMessage('Start Seaweed S3 API Server')).start(); containers.push(seaweed);
  const bucket = await seaweed.exec(['sh', '-c', "printf 's3.bucket.create -name user-files\\n' | weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888"]);
  assert.equal(bucket.exitCode, 0);
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const { port } = reservation.address(); await new Promise(resolve => reservation.close(resolve));
  const env = { ...process.env, ...example, NODE_ENV: 'test', PORT: String(port), SWAGGER_ENABLED: 'false',
    DATABASE_URL: postgres.getConnectionUri(), REDIS_URL: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    S3_ENDPOINT: `http://${seaweed.getHost()}:${seaweed.getMappedPort(8333)}` };
  await run(process.execPath, [fileURLToPath(new URL('node_modules/prisma/build/index.js', apiRoot)), 'migrate', 'deploy', '--config', 'prisma.config.ts'], apiRoot, env);
  api = spawn(process.execPath, ['dist/main.js'], { cwd: fileURLToPath(apiRoot), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.resume(); let diagnostics = '';
  api.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (api.exitCode !== null) throw new Error(`API exited: ${diagnostics}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/user/me`); ready = response.status === 401; await response.body?.cancel(); if (ready) break; } catch { /* Wait for startup. */ }
    await delay(100);
  }
  assert.ok(ready, 'API must start');
  await run(process.execPath, [fileURLToPath(new URL('node_modules/@playwright/test/cli.js', webRoot)), 'test'], webRoot,
    { ...process.env, TEST_REAL_API: 'true', API_PROXY_TARGET: `http://127.0.0.1:${port}` });
} finally {
  if (api && api.exitCode === null) { api.kill(); await once(api, 'exit'); }
  await Promise.allSettled(containers.reverse().map(container => container.stop()));
}

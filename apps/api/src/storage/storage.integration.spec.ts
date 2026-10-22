import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { envSchema } from '../config/env.schema.js';
import { StorageService } from './storage.service.js';

const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));
const localConfig = envSchema.parse(example);

describe('StorageService with SeaweedFS', () => {
  let container: StartedTestContainer | undefined;
  let storage: StorageService | undefined;

  function service(): StorageService {
    if (!storage) throw new Error('Test storage is not initialized');
    return storage;
  }

  beforeAll(async () => {
    // Отдельное временное хранилище: локальные объекты разработчика не затрагиваются.
    container = await new GenericContainer('chrislusf/seaweedfs:4.48')
      .withEnvironment({
        AWS_ACCESS_KEY_ID: localConfig.S3_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: localConfig.S3_SECRET_ACCESS_KEY,
      })
      .withExposedPorts(8333)
      .withCommand([
        'server', '-dir=/data', '-ip=127.0.0.1', '-ip.bind=0.0.0.0',
        '-volume.max=5', '-master.volumeSizeLimitMB=1024', '-filer', '-s3',
      ])
      .withWaitStrategy(Wait.forLogMessage('Start Seaweed S3 API Server'))
      .start();
    await container.exec([
      'sh', '-c',
      "printf 's3.bucket.create -name user-files\\n' | weed shell -master=127.0.0.1:9333 -filer=127.0.0.1:8888",
    ]);
    const config = envSchema.parse({
      ...example,
      S3_ENDPOINT: `http://${container.getHost()}:${container.getMappedPort(8333)}`,
    });
    storage = new StorageService(new ConfigService(config));
    await storage.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    storage?.onModuleDestroy();
    await container?.stop();
  }, 30_000);

  it('creates and finds a Unicode directory marker without exposing it to another user', async () => {
    const path = 'Папка #1?%/';
    expect(await service().resourceExists(42, path)).toBe(false);
    await service().createDirectory(42, path);
    expect(await service().resourceExists(42, path)).toBe(true);
    expect(await service().resourceExists(43, path)).toBe(false);
  });

  it('rejects a repeated conditional write', async () => {
    await service().createDirectory(42, 'duplicate/');
    await expect(service().createDirectory(42, 'duplicate/')).rejects.toThrow(ConflictException);
  });

  it('allows only one of two simultaneous writes of the same directory', async () => {
    const results = await Promise.allSettled([
      service().createDirectory(42, 'race/'),
      service().createDirectory(42, 'race/'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')?.reason).toBeInstanceOf(ConflictException);
  });
});

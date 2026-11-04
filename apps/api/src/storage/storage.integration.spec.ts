import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { parseEnv } from 'node:util';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { envSchema } from '../config/env.schema.js';
import { StorageService } from './storage.service.js';

function fileChunks(mebibytes: number): Readable {
  return Readable.from((function* () {
    for (let index = 0; index < mebibytes; index++) yield Buffer.alloc(1024 ** 2, 42);
  })(), { objectMode: false });
}

const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));
const localConfig = envSchema.parse(example);

describe('StorageService with SeaweedFS', () => {
  let container: StartedTestContainer | undefined;
  let storage: StorageService | undefined;
  let limitedStorage: StorageService | undefined;

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
    limitedStorage = new StorageService(new ConfigService({ ...config, UPLOAD_MAX_FILE_SIZE_BYTES: 6 * 1024 ** 2 }));
    await storage.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    storage?.onModuleDestroy();
    limitedStorage?.onModuleDestroy();
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

  it('renames a Unicode directory tree and moves a file without renaming it', async () => {
    await service().createDirectory(81, 'Папка #1/');
    await service().createDirectory(81, 'Папка #1/Вложенная/');
    const name = 'Отчёт 100%.txt';
    await service().uploadFile(81, `Папка #1/Вложенная/${name}`, Readable.from(['hello']));
    await expect(service().moveResource(81, 'Папка #1/', 'Новая папка/')).resolves.toEqual({
      path: '', name: 'Новая папка', type: 'DIRECTORY',
    });
    await expect(service().resourceExists(81, 'Папка #1/')).resolves.toBe(false);
    await expect(service().resourceExists(81, `Папка #1/Вложенная/${name}`)).resolves.toBe(false);
    await expect(service().moveResource(81, `Новая папка/Вложенная/${name}`, name)).resolves.toEqual({
      path: '', name, size: 5, type: 'FILE',
    });
    await expect(service().listDirectory(81, 'Новая папка/Вложенная/')).resolves.toEqual([]);
  }, 30_000);

  it('keeps both files when the move destination is occupied', async () => {
    await service().uploadFile(82, 'source', Readable.from(['source']));
    await service().uploadFile(82, 'target', Readable.from(['target!']));
    await expect(service().moveResource(82, 'source', 'target')).rejects.toThrow(ConflictException);
    await expect(service().getResource(82, 'source')).resolves.toMatchObject({ size: 6 });
    await expect(service().getResource(82, 'target')).resolves.toMatchObject({ size: 7 });
  });

  it('streams a multipart file and refuses to overwrite it', async () => {
    const path = 'Отчёт #1.txt';
    await expect(service().uploadFile(71, path, fileChunks(6))).resolves.toBe(6 * 1024 ** 2);
    await expect(service().uploadFile(71, path, Readable.from(['replacement']))).rejects.toThrow(ConflictException);
    await expect(service().uploadFile(71, path, fileChunks(7))).rejects.toThrow(ConflictException);
    await expect(service().getResource(71, path)).resolves.toMatchObject({ size: 6 * 1024 ** 2 });
    await expect(service().resourceExists(72, path)).resolves.toBe(false);
  }, 30_000);

  it('does not publish a file when its stream exceeds the size limit', async () => {
    if (!limitedStorage) throw new Error('Test storage is not initialized');
    await expect(limitedStorage.uploadFile(71, 'too-large', fileChunks(8))).rejects.toThrow(BadRequestException);
    await expect(limitedStorage.resourceExists(71, 'too-large')).resolves.toBe(false);
  });

  it('deletes a subtree without deleting siblings or another user’s subtree', async () => {
    await service().createDirectory(61, 'Удалить/');
    await service().createDirectory(61, 'Удалить/Вложенная/');
    await service().createDirectory(61, 'Удалить позже/');
    await service().createDirectory(62, 'Удалить/');
    await service().deleteResource(61, 'Удалить/');
    expect(await service().resourceExists(61, 'Удалить/')).toBe(false);
    expect(await service().resourceExists(61, 'Удалить/Вложенная/')).toBe(false);
    expect(await service().resourceExists(61, 'Удалить позже/')).toBe(true);
    expect(await service().resourceExists(62, 'Удалить/')).toBe(true);
    await expect(service().deleteResource(61, 'Удалить/')).rejects.toMatchObject({ status: 404 });
  });

  it('lists only direct children, hides markers and isolates the root by user', async () => {
    await service().createDirectory(55, 'Документы/');
    await service().createDirectory(55, 'Документы/Отчёты/');
    await service().createDirectory(55, 'Документы/Отчёты/Архив/');
    await expect(service().listDirectory(55, '')).resolves.toEqual([
      { path: '', name: 'Документы', type: 'DIRECTORY' },
    ]);
    await expect(service().listDirectory(55, 'Документы/')).resolves.toEqual([
      { path: 'Документы/', name: 'Отчёты', type: 'DIRECTORY' },
    ]);
    await expect(service().listDirectory(55, 'Документы/Отчёты/Архив/')).resolves.toEqual([]);
    await expect(service().listDirectory(56, '')).resolves.toEqual([]);
    await expect(service().listDirectory(56, 'Документы/')).rejects.toMatchObject({ status: 404 });
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

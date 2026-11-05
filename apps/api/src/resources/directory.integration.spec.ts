import { directoryResourceSchema } from '@app/shared';
import { BadRequestException, ConflictException, Controller, NotFoundException, Param, Post, Req } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { parseEnv } from 'node:util';
import { createClient, type RedisClientType } from 'redis';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { AuthGuard } from '../auth/auth.guard.js';
import { Public } from '../auth/public.decorator.js';
import { configureApp } from '../configure-app.js';
import { envSchema } from '../config/env.schema.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ResourcesModule } from './resources.module.js';

// Только тестовый способ получить сессии двух пользователей; в сборку API не входит.
@Controller('__identity')
class IdentityController {
  constructor(private readonly sessions: SessionsService) {}

  @Post(':user')
  @Public()
  async create(@Param('user') user: string, @Req() req: Request) {
    await this.sessions.start(req, user === 'first' ? 1 : 2);
    return {};
  }
}

const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));

describe('POST /api/directory', () => {
  const objects = new Map<number, Set<string>>();
  const storage = {
    resourceExists: vi.fn<StorageService['resourceExists']>(),
    createDirectory: vi.fn<StorageService['createDirectory']>(),
    getResource: vi.fn<StorageService['getResource']>(),
    searchResources: vi.fn<StorageService['searchResources']>(),
    openFile: vi.fn<StorageService['openFile']>(),
    downloadEntries: vi.fn<StorageService['downloadEntries']>(),
    listDirectory: vi.fn<StorageService['listDirectory']>(),
    deleteResource: vi.fn<StorageService['deleteResource']>(),
    moveResource: vi.fn<StorageService['moveResource']>(),
    validateUploadDestination: vi.fn<StorageService['validateUploadDestination']>(),
    planUploadFile: vi.fn<StorageService['planUploadFile']>(),
    uploadFile: vi.fn<StorageService['uploadFile']>(),
    rollbackUploadObject: vi.fn<StorageService['rollbackUploadObject']>(),
  };
  let container: StartedTestContainer | undefined;
  let observer: RedisClientType;
  let app: NestExpressApplication | undefined;
  let firstCookie: string;
  let secondCookie: string;

  function http() {
    if (!app) throw new Error('Test application is not initialized');
    return request(app.getHttpServer());
  }

  beforeAll(async () => {
    container = await new GenericContainer('redis:8.2.2-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections')).start();
    const redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    const config = envSchema.parse({ ...example, REDIS_URL: redisUrl, UPLOAD_MAX_FILES: '2', UPLOAD_MAX_FILE_SIZE_BYTES: '3' });
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, skipProcessEnv: true,
          load: [() => config],
        }),
        SessionsModule,
        ResourcesModule,
      ],
      controllers: [IdentityController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    }).overrideProvider(StorageService).useValue(storage).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    observer = createClient({ url: redisUrl });
    observer.on('error', (error: Error) => { throw error; });
    await observer.connect();
  }, 120_000);

  beforeEach(async () => {
    objects.clear();
    objects.set(1, new Set());
    objects.set(2, new Set());
    storage.getResource.mockReset().mockRejectedValue(new NotFoundException('Resource not found'));
    storage.searchResources.mockReset().mockResolvedValue([]);
    storage.openFile.mockReset();
    storage.downloadEntries.mockReset();
    storage.listDirectory.mockReset().mockResolvedValue([]);
    storage.deleteResource.mockReset().mockResolvedValue(undefined);
    storage.moveResource.mockReset();
    storage.validateUploadDestination.mockReset().mockResolvedValue('');
    storage.planUploadFile.mockReset().mockReturnValue({ path: 'Папка/Отчёт.txt', parent: 'Папка/', name: 'Отчёт.txt', directories: ['Папка/'] });
    storage.uploadFile.mockReset().mockImplementation(async (_user, _path, source) => {
      let size = 0;
      for await (const chunk of source) size += Buffer.byteLength(chunk);
      return size;
    });
    storage.rollbackUploadObject.mockReset().mockResolvedValue(undefined);
    storage.resourceExists.mockReset().mockImplementation(async (userId, path) => {
      return typeof path === 'string' && (objects.get(userId)?.has(path) ?? false);
    });
    storage.createDirectory.mockReset().mockImplementation(async (userId, path) => {
      const entries = objects.get(userId);
      if (entries?.has(path)) throw new ConflictException('Directory already exists');
      entries?.add(path);
    });
    await observer.flushDb();
    const first = await http().post('/api/__identity/first').expect(201);
    const second = await http().post('/api/__identity/second').expect(201);
    firstCookie = first.headers['set-cookie'][0].split(';')[0];
    secondCookie = second.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (observer?.isOpen) await observer.close();
    } finally {
      await container?.stop();
    }
  }, 30_000);

  it('creates a directory in the root and returns the public resource contract', async () => {
    const response = await http().post('/api/directory').query({ path: 'Документы/' })
      .set('Cookie', firstCookie).expect(201);
    expect(directoryResourceSchema.parse(response.body)).toEqual({ path: '', name: 'Документы', type: 'DIRECTORY' });
    expect(storage.createDirectory).toHaveBeenCalledExactlyOnceWith(1, 'Документы/');
    expect(storage.resourceExists).not.toHaveBeenCalledWith(1, '');
  });

  it('returns resource metadata using only the session identity', async () => {
    storage.getResource.mockResolvedValueOnce({ path: 'docs/', name: 'report.txt', size: 42, type: 'FILE' });
    await http().get('/api/resource').query({ path: 'docs/report.txt', userId: 2 })
      .set('Cookie', firstCookie).expect(200, { path: 'docs/', name: 'report.txt', size: 42, type: 'FILE' });
    expect(storage.getResource).toHaveBeenCalledExactlyOnceWith(1, 'docs/report.txt');
  });

  it('trims the search query and takes the search scope from the session', async () => {
    await http().get('/api/resource/search').query({ query: '  Отчёт  ', userId: 2 })
      .set('Cookie', firstCookie).expect(200, []);
    expect(storage.searchResources).toHaveBeenCalledExactlyOnceWith(1, 'Отчёт');
  });

  it('rejects missing, blank, long and repeated search queries', async () => {
    for (const query of [undefined, '  ', 'а'.repeat(101), ['a', 'b']]) {
      await http().get('/api/resource/search').query({ query }).set('Cookie', firstCookie).expect(400);
    }
    await http().get('/api/resource/search?query=test').expect(401);
    expect(storage.searchResources).not.toHaveBeenCalled();
  });

  it('streams a file as an attachment using the session identity', async () => {
    storage.getResource.mockResolvedValueOnce({ path: '', name: 'Отчёт.txt', size: 3, type: 'FILE' });
    storage.openFile.mockResolvedValueOnce(Readable.from(['abc']));
    const response = await http().get('/api/resource/download').query({ path: 'Отчёт.txt', userId: 2 })
      .set('Cookie', firstCookie).expect(200).expect('Content-Type', 'application/octet-stream');
    expect(response.headers['content-disposition']).toContain('filename*=UTF-8');
    expect(response.body).toEqual(Buffer.from('abc'));
    expect(storage.openFile).toHaveBeenCalledExactlyOnceWith(1, 'Отчёт.txt', expect.any(AbortSignal));
  });

  it('streams a ZIP with relative Unicode names and an empty directory', async () => {
    storage.getResource.mockResolvedValueOnce({ path: '', name: 'docs', type: 'DIRECTORY' });
    storage.downloadEntries.mockImplementationOnce(async function* () {
      yield 'Пустая/';
      yield 'Отчёт.txt';
    });
    storage.openFile.mockResolvedValueOnce(Readable.from(['abc']));
    const response = await http().get('/api/resource/download').query({ path: 'docs/' })
      .set('Cookie', firstCookie).expect(200);
    expect(response.headers['content-disposition']).toContain('filename="docs.zip"');
    expect(response.body.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(response.body.includes(Buffer.from('Пустая/'))).toBe(true);
    expect(response.body.includes(Buffer.from('Отчёт.txt'))).toBe(true);
    expect(storage.openFile).toHaveBeenCalledExactlyOnceWith(1, 'docs/Отчёт.txt', expect.any(AbortSignal));
  });

  it('sends JSON before streaming if the resource is missing', async () => {
    await http().get('/api/resource/download').query({ path: 'missing' })
      .set('Cookie', firstCookie).expect(404).expect('Content-Type', /json/);
    expect(storage.openFile).not.toHaveBeenCalled();
  });

  it.each([
    ['get', '/api/resource?path=file'], ['delete', '/api/resource?path=file'],
    ['get', '/api/resource/download?path=file'], ['get', '/api/resource/search?query=a'],
    ['post', '/api/resource?path='], ['post', '/api/resource/move?from=a&to=b'],
    ['get', '/api/directory?path='], ['post', '/api/directory?path=docs%2F'],
  ] as const)('requires a session for %s %s', async (method, path) => {
    await http()[method](path).expect(401);
  });

  it.each(['../secret', '/absolute', 'a//b', 'a\\b', 'a\u0000b'])
    ('rejects unsafe paths on every path-taking operation: %s', async path => {
      for (const method of ['get', 'delete'] as const) {
        await http()[method]('/api/resource').query({ path }).set('Cookie', firstCookie).expect(400);
      }
      await http().get('/api/resource/download').query({ path }).set('Cookie', firstCookie).expect(400);
      await http().post('/api/resource').query({ path }).set('Cookie', firstCookie).expect(400);
      for (const method of ['get', 'post'] as const) {
        await http()[method]('/api/directory').query({ path }).set('Cookie', firstCookie).expect(400);
      }
      await http().post('/api/resource/move').query({ from: path, to: 'safe' }).set('Cookie', firstCookie).expect(400);
      await http().post('/api/resource/move').query({ from: 'safe', to: path }).set('Cookie', firstCookie).expect(400);
    });

  it('rejects URL-encoded traversal before the download handler', async () => {
    await http().get('/api/resource/download?path=%2E%2E%2Fsecret')
      .set('Cookie', firstCookie).expect(400);
    expect(storage.openFile).not.toHaveBeenCalled();
  });

  it('aborts the response when a file fails after it has started streaming', async () => {
    storage.getResource.mockResolvedValueOnce({ path: '', name: 'file', size: 10, type: 'FILE' });
    storage.openFile.mockResolvedValueOnce(Readable.from((async function* () {
      yield 'first';
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error('provider stream failure');
    })()));
    await expect(http().get('/api/resource/download?path=file').set('Cookie', firstCookie))
      .rejects.toThrow(/aborted|reset|closed/i);
  });

  it('accepts the explicit root path and uses the session owner for listing', async () => {
    await http().get('/api/directory?path=&userId=2').set('Cookie', firstCookie).expect(200, []);
    expect(storage.listDirectory).toHaveBeenCalledExactlyOnceWith(1, '');
  });

  it('rejects absent and file paths for directory listings', async () => {
    await http().get('/api/directory').set('Cookie', firstCookie).expect(400);
    await http().get('/api/directory').query({ path: 'file.txt' }).set('Cookie', firstCookie).expect(400);
    expect(storage.listDirectory).not.toHaveBeenCalled();
  });

  it('deletes as the session user and sends 204 without a body', async () => {
    const response = await http().delete('/api/resource').query({ path: 'docs/', userId: 2 })
      .set('Cookie', firstCookie).expect(204);
    expect(response.text).toBe('');
    expect(storage.deleteResource).toHaveBeenCalledExactlyOnceWith(1, 'docs/');
  });

  it('moves as the session user and returns the new resource with 200', async () => {
    const moved = { path: '', name: 'новая', type: 'DIRECTORY' } as const;
    storage.moveResource.mockResolvedValueOnce(moved);
    await http().post('/api/resource/move').query({ from: 'старая/', to: 'новая/', userId: 2 })
      .set('Cookie', firstCookie).expect(200, moved);
    expect(storage.moveResource).toHaveBeenCalledExactlyOnceWith(1, 'старая/', 'новая/');
    await http().post('/api/resource/move?from=old').set('Cookie', firstCookie).expect(400);
    expect(storage.moveResource).toHaveBeenCalledOnce();
  });

  it('rejects unauthenticated, root and missing-path deletions before storage', async () => {
    await http().delete('/api/resource?path=file').expect(401);
    await http().delete('/api/resource?path=').set('Cookie', firstCookie).expect(400);
    await http().delete('/api/resource').set('Cookie', firstCookie).expect(400);
    expect(storage.deleteResource).not.toHaveBeenCalled();
  });

  function multipart(...files: Array<string | { name: string; body: string }>): string {
    return files.map(file => {
      const { name, body } = typeof file === 'string' ? { name: file, body: 'abc' } : file;
      return `--test\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\n\r\n${body}\r\n`;
    }).join('') + '--test--\r\n';
  }

  it('preserves UTF-8 multipart paths and streams the file', async () => {
    await http().post('/api/resource?path=').set('Cookie', firstCookie)
      .set('Content-Type', 'multipart/form-data; boundary=test').send(multipart('Папка/Отчёт.txt'))
      .expect(201, [{ path: 'Папка/', name: 'Отчёт.txt', size: 3, type: 'FILE' }]);
    expect(storage.validateUploadDestination).toHaveBeenCalledExactlyOnceWith(1, '');
    expect(storage.planUploadFile).toHaveBeenCalledExactlyOnceWith(1, '', 'Папка/Отчёт.txt');
  });

  it('rolls back the written file and new directory when a later file conflicts', async () => {
    await http().post('/api/resource?path=').set('Cookie', firstCookie)
      .set('Content-Type', 'multipart/form-data; boundary=test').send(multipart('Папка/Отчёт.txt', 'Папка/Отчёт.txt'))
      .expect(409);
    expect(storage.uploadFile).toHaveBeenCalledOnce();
    expect(storage.rollbackUploadObject.mock.calls).toEqual([[1, 'Папка/Отчёт.txt'], [1, 'Папка/']]);
  });

  it.each([multipart({ name: 'large.txt', body: 'abcd' }), multipart('a', 'b', 'c')])
    ('returns 400 for an upload over the configured size or count limit', async body => {
      await http().post('/api/resource?path=').set('Cookie', firstCookie)
        .set('Content-Type', 'multipart/form-data; boundary=test').send(body).expect(400);
    });

  it('rejects an invalid destination before processing multipart files', async () => {
    storage.validateUploadDestination.mockRejectedValueOnce(new BadRequestException('Upload directory does not exist'));
    await http().post('/api/resource?path=missing%2F').set('Cookie', firstCookie)
      .set('Content-Type', 'multipart/form-data; boundary=test').send(multipart('file.txt')).expect(400);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it.each([{}, { path: '' }, { path: '../secret' }, { path: ['a', 'b'] }])
    ('rejects invalid metadata queries %j before storage', async query => {
      await http().get('/api/resource').query(query).set('Cookie', firstCookie).expect(400);
      expect(storage.getResource).not.toHaveBeenCalled();
    });

  it('protects resource metadata before validation', async () => {
    await http().get('/api/resource').expect(401);
    expect(storage.getResource).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing resource', async () => {
    await http().get('/api/resource').query({ path: 'missing/' }).set('Cookie', firstCookie)
      .expect(404, { statusCode: 404, error: 'Not Found', message: 'Resource not found' });
  });

  it('does not expose provider failures in metadata responses', async () => {
    storage.getResource.mockRejectedValueOnce(new Error('Private S3 endpoint and credentials'));
    await http().get('/api/resource').query({ path: 'file' }).set('Cookie', firstCookie)
      .expect(500, { statusCode: 500, message: 'Internal server error' });
  });

  it('creates a nested directory only under an existing parent', async () => {
    objects.get(1)?.add('docs/');
    await http().post('/api/directory').query({ path: 'docs/reports/' }).set('Cookie', firstCookie)
      .expect(201, { path: 'docs/', name: 'reports', type: 'DIRECTORY' });
  });

  it('returns 404 without writing if the parent directory is missing', async () => {
    const response = await http().post('/api/directory').query({ path: 'missing/child/' })
      .set('Cookie', firstCookie).expect(404);
    expect(response.body).toEqual({ statusCode: 404, error: 'Not Found', message: 'Parent directory does not exist' });
    expect(storage.createDirectory).not.toHaveBeenCalled();
  });

  it('returns 409 without rewriting an existing directory', async () => {
    objects.get(1)?.add('docs/');
    await http().post('/api/directory').query({ path: 'docs/' }).set('Cookie', firstCookie).expect(409);
    expect(storage.createDirectory).not.toHaveBeenCalled();
  });

  it('allows a file and directory to have the same name', async () => {
    objects.get(1)?.add('docs');
    await http().post('/api/directory').query({ path: 'docs/' }).set('Cookie', firstCookie).expect(201);
    expect(objects.get(1)?.has('docs')).toBe(true);
    expect(objects.get(1)?.has('docs/')).toBe(true);
  });

  it.each(['', 'docs', '../docs/', 'a/../b/', '/docs/', 'a//b/', 'a\\b/', 'a\u0000b/', ' docs/', 'a'.repeat(256) + '/'])
    ('returns 400 for invalid paths without contacting storage', async path => {
      await http().post('/api/directory').query({ path }).set('Cookie', firstCookie).expect(400);
      expect(storage.resourceExists).not.toHaveBeenCalled();
      expect(storage.createDirectory).not.toHaveBeenCalled();
    });

  it('returns 400 when path is absent or repeated', async () => {
    await http().post('/api/directory').set('Cookie', firstCookie).expect(400);
    await http().post('/api/directory?path=a%2F&path=b%2F').set('Cookie', firstCookie).expect(400);
    expect(storage.createDirectory).not.toHaveBeenCalled();
  });

  it('runs the guard before path validation for anonymous requests', async () => {
    await http().post('/api/directory').query({ path: '../secret/' }).expect(401);
    expect(storage.resourceExists).not.toHaveBeenCalled();
  });

  it('does not decode URL paths a second time', async () => {
    await http().post('/api/directory?path=%2E%2E%2Fsecret%2F').set('Cookie', firstCookie).expect(400);
    await http().post('/api/directory').query({ path: '%2E%2E/' }).set('Cookie', firstCookie)
      .expect(201, { path: '', name: '%2E%2E', type: 'DIRECTORY' });
  });

  it('preserves URL-sensitive characters', async () => {
    await http().post('/api/directory').query({ path: '100% #1? &+/' }).set('Cookie', firstCookie)
      .expect(201, { path: '', name: '100% #1? &+', type: 'DIRECTORY' });
  });

  it('does not use another user parent directory or a supplied userId', async () => {
    objects.get(1)?.add('private/');
    await http().post('/api/directory').query({ path: 'private/child/', userId: 1 })
      .set('Cookie', secondCookie).expect(404);
    expect(storage.resourceExists).toHaveBeenCalledWith(2, 'private/');
    expect(storage.createDirectory).not.toHaveBeenCalled();
  });

  it('allows the same directory path for different users', async () => {
    await http().post('/api/directory').query({ path: 'docs/' }).set('Cookie', firstCookie).expect(201);
    await http().post('/api/directory').query({ path: 'docs/' }).set('Cookie', secondCookie).expect(201);
    expect(storage.createDirectory).toHaveBeenNthCalledWith(1, 1, 'docs/');
    expect(storage.createDirectory).toHaveBeenNthCalledWith(2, 2, 'docs/');
  });

  it('preserves a conflict reported during the storage write', async () => {
    storage.createDirectory.mockRejectedValueOnce(new ConflictException('Directory already exists'));
    await http().post('/api/directory').query({ path: 'docs/' }).set('Cookie', firstCookie).expect(409);
  });

  it('returns a standard 500 without exposing storage errors', async () => {
    storage.createDirectory.mockRejectedValueOnce(new Error('private S3 key user-1-files/docs/'));
    const response = await http().post('/api/directory').query({ path: 'docs/' })
      .set('Cookie', firstCookie).expect(500);
    expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(response.text).not.toContain('user-1-files');
  });
});

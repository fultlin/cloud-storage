import { directoryResourceSchema } from '@app/shared';
import { ConflictException, Controller, Param, Post, Req } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { readFileSync } from 'node:fs';
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
    const config = envSchema.parse({ ...example, REDIS_URL: redisUrl });
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

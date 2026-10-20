import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient, type RedisClientType } from 'redis';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { configureApp } from '../configure-app.js';
import { envSchema } from '../config/env.schema.js';
import { SessionsModule } from './sessions.module.js';

// Контроллер существует только в тестах; production-сборка исключает *.spec.ts.
@Controller('__session_probe')
class SessionProbeController {
  @Get()
  read(@Req() req: Request) {
    return { userId: req.session.userId ?? null };
  }

  @Post()
  async write(@Req() req: Request) {
    req.session.userId = 42;
    await new Promise<void>((resolve, reject) => {
      req.session.save(error => error ? reject(error) : resolve());
    });
    return { userId: req.session.userId };
  }

  @Delete()
  async remove(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy(error => error ? reject(error) : resolve());
    });
    res.clearCookie('sid', { path: '/' });
    return { deleted: true };
  }
}

const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));
const route = '/api/__session_probe';

describe('Redis sessions', () => {
  let container: StartedTestContainer | undefined;
  let observer: RedisClientType;
  let redisUrl: string;
  let app: NestExpressApplication | undefined;

  async function createApp(secure = false, trustProxy = false): Promise<NestExpressApplication> {
    const config = envSchema.parse({
      ...example,
      REDIS_URL: redisUrl,
      SESSION_TTL_SECONDS: '120',
      COOKIE_SECURE: String(secure),
      TRUST_PROXY: String(trustProxy),
    });
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          skipProcessEnv: true,
          load: [() => config],
        }),
        SessionsModule,
      ],
      controllers: [SessionProbeController],
    }).compile();
    const application = moduleFixture.createNestApplication<NestExpressApplication>();
    configureApp(application);
    await application.init();
    return application;
  }

  function http() {
    if (!app) throw new Error('Test application is not initialized');
    return request(app.getHttpServer());
  }

  function cookieFrom(response: { headers: Record<string, unknown> }): string {
    const cookies = response.headers['set-cookie'];
    if (!Array.isArray(cookies) || typeof cookies[0] !== 'string') {
      throw new Error('Session cookie was not set');
    }
    return cookies[0].split(';')[0];
  }

  beforeAll(async () => {
    container = await new GenericContainer('redis:8.2.2-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    observer = createClient({ url: redisUrl });
    observer.on('error', (error: Error) => { throw error; });
    await observer.connect();
  }, 120_000);

  beforeEach(async () => {
    // Сбрасываем только временный Redis из Testcontainers, не локальный Compose.
    await observer.flushDb();
    app = await createApp();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    try {
      if (observer?.isOpen) await observer.close();
    } finally {
      await container?.stop();
    }
  }, 30_000);

  it('does not save anonymous sessions or set cookies', async () => {
    const response = await http().get(route).expect(200, { userId: null });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await observer.dbSize()).toBe(0);
  });

  it('stores userId in Redis with TTL and sends a signed HttpOnly SameSite cookie', async () => {
    const response = await http().post(route).expect(201);
    const cookie = cookieFrom(response);
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    expect(response.headers['set-cookie'][0]).toContain('Path=/');
    expect(response.headers['set-cookie'][0]).not.toContain('; Secure');

    const [key] = await observer.keys('sess:*');
    expect(key).toBeDefined();
    const stored = JSON.parse((await observer.get(key)) ?? '{}') as Record<string, unknown>;
    expect(stored.userId).toBe(42);
    expect(Object.keys(stored).sort()).toEqual(['cookie', 'userId']);
    expect(stored.cookie).toMatchObject({ originalMaxAge: 120_000 });
    expect(await observer.ttl(key)).toBeGreaterThan(115);
    expect(await observer.ttl(key)).toBeLessThanOrEqual(120);
    expect(decodeURIComponent(cookie)).toMatch(/^sid=s:/);
    expect(cookie).not.toContain('userId');
    await http().get(route).set('Cookie', cookie).expect(200, { userId: 42 });
  });

  it('restores a session after closing and recreating the Nest application', async () => {
    const cookie = cookieFrom(await http().post(route).expect(201));
    await app?.close();
    app = await createApp();
    await http().get(route).set('Cookie', cookie).expect(200, { userId: 42 });
  });

  it('rejects a cookie with a modified signature', async () => {
    const cookie = cookieFrom(await http().post(route).expect(201));
    const modified = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
    await http().get(route).set('Cookie', modified).expect(200, { userId: null });
  });

  it('removes the session from Redis so the old cookie no longer identifies a user', async () => {
    const cookie = cookieFrom(await http().post(route).expect(201));
    await http().delete(route).set('Cookie', cookie).expect(200);
    expect(await observer.dbSize()).toBe(0);
    await http().get(route).set('Cookie', cookie).expect(200, { userId: null });
  });

  it('stops identifying a user when the Redis session expires', async () => {
    const cookie = cookieFrom(await http().post(route).expect(201));
    const [key] = await observer.keys('sess:*');
    await observer.expire(key, 1);
    await vi.waitFor(async () => {
      expect(await observer.exists(key)).toBe(0);
    }, { timeout: 5000, interval: 100 });
    await http().get(route).set('Cookie', cookie).expect(200, { userId: null });
  });

  it('sets Secure cookies behind one trusted HTTPS proxy', async () => {
    await app?.close();
    app = await createApp(true, true);
    const response = await http().post(route).set('X-Forwarded-Proto', 'https').expect(201);
    expect(response.headers['set-cookie'][0]).toContain('; Secure');
  });

  it('does not accept forwarded HTTPS without trust proxy', async () => {
    await app?.close();
    app = await createApp(true, false);
    const response = await http().post(route).set('X-Forwarded-Proto', 'https').expect(201);
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

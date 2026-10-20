import { ConfigModule } from '@nestjs/config';
import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { verify } from 'argon2';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';
import { createClient, type RedisClientType } from 'redis';
import request from 'supertest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { configureApp } from '../configure-app.js';
import { envSchema } from '../config/env.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { AuthModule } from './auth.module.js';

const execFileAsync = promisify(execFile);
const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));
const route = '/api/auth/sign-up';
const credentials = { username: 'user_1', password: 'valid-password' };

// Намеренно без @Public и без локального @UseGuards: проверяем глобальную защиту.
@Controller('__protected_probe')
class ProtectedProbeController {
  @Get()
  read() {
    return { protected: true };
  }
}

describe('Auth HTTP API', () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let redis: StartedTestContainer | undefined;
  let observer: RedisClientType;
  let app: NestExpressApplication | undefined;
  let prisma: PrismaService;
  let users: UsersService;

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
    postgres = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    redis = await new GenericContainer('redis:8.2.2-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .start();
    const databaseUrl = postgres.getConnectionUri();
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url)),
      'migrate', 'deploy', '--config', 'prisma.config.ts',
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000,
    });

    const config = envSchema.parse({ ...example, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl });
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          skipProcessEnv: true,
          load: [() => config],
        }),
        AuthModule,
      ],
      controllers: [ProtectedProbeController],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    users = app.get(UsersService);
    observer = createClient({ url: redisUrl });
    observer.on('error', (error: Error) => { throw error; });
    await observer.connect();
  }, 120_000);

  beforeEach(async () => {
    // Очистка ограничена временными контейнерами этого тестового файла.
    await Promise.all([prisma.user.deleteMany(), observer.flushDb()]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await app?.close();
      if (observer?.isOpen) await observer.close();
    } finally {
      await Promise.all([postgres?.stop(), redis?.stop()]);
    }
  }, 30_000);

  it('returns 201, stores a hash, and creates a session with the new user id', async () => {
    const response = await http().post(route).send(credentials).expect(201, { username: 'user_1' });
    const cookie = cookieFrom(response);
    expect(cookie).toMatch(/^sid=/);
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'user_1' } });
    expect(await verify(user.passwordHash, credentials.password)).toBe(true);
    const [key] = await observer.keys('sess:*');
    expect(await observer.dbSize()).toBe(1);
    expect(JSON.parse((await observer.get(key)) ?? '{}')).toMatchObject({ userId: user.id });
    expect(await observer.ttl(key)).toBeGreaterThan(0);
  });

  it.each([
    {},
    { username: 'ab', password: 'valid-password' },
    { username: 'User_1', password: 'valid-password' },
    { username: 'user_1', password: 'short' },
    { username: 'user_1', password: 'a'.repeat(65) },
    { username: 123, password: 'valid-password' },
    { username: 'user_1', password: 12345678 },
  ])('returns 400 for invalid input without creating an account or session', async body => {
    const response = await http().post(route).send(body).expect(400);
    expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(typeof response.body.message === 'string' || Array.isArray(response.body.message)).toBe(true);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await prisma.user.count()).toBe(0);
    expect(await observer.dbSize()).toBe(0);
  });

  it('returns 409 for an existing username without replacing its password', async () => {
    await http().post(route).send(credentials).expect(201);
    const response = await http().post(route)
      .send({ ...credentials, password: 'another-password' }).expect(409);
    expect(response.body).toEqual({
      statusCode: 409, error: 'Conflict', message: 'Username is already taken',
    });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await prisma.user.count()).toBe(1);
    expect(await users.verifyCredentials(credentials.username, credentials.password)).not.toBeNull();
    expect(await observer.dbSize()).toBe(1);
  });

  it('replaces an existing session id when registering another account', async () => {
    const firstCookie = cookieFrom(await http().post(route).send(credentials).expect(201));
    const [oldKey] = await observer.keys('sess:*');
    const response = await http().post(route).set('Cookie', firstCookie)
      .send({ username: 'second_user', password: 'valid-password' }).expect(201);
    expect(cookieFrom(response)).not.toBe(firstCookie);
    expect(await observer.exists(oldKey)).toBe(0);
    const second = await prisma.user.findUniqueOrThrow({ where: { username: 'second_user' } });
    const [newKey] = await observer.keys('sess:*');
    expect(JSON.parse((await observer.get(newKey)) ?? '{}')).toMatchObject({ userId: second.id });
    expect(await observer.dbSize()).toBe(1);
  });

  it('ignores a userId supplied in the request body', async () => {
    await http().post(route).send({ ...credentials, userId: 999999 }).expect(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { username: 'user_1' } });
    const [key] = await observer.keys('sess:*');
    expect(JSON.parse((await observer.get(key)) ?? '{}')).toMatchObject({ userId: user.id });
  });

  it('returns 500 without leaking implementation details on an unexpected error', async () => {
    vi.spyOn(users, 'create').mockRejectedValueOnce(new Error('sensitive-database-detail'));
    const response = await http().post(route).send(credentials).expect(500);
    expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(response.text).not.toContain('sensitive-database-detail');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await observer.dbSize()).toBe(0);
  });

  it('does not report success or leave a session when Redis refuses the save', async () => {
    // Меняем ACL только в отдельном Redis этого тестового файла.
    await observer.sendCommand(['ACL', 'SETUSER', 'default', '-set']);
    try {
      const response = await http().post(route).send(credentials).expect(500);
      expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await observer.dbSize()).toBe(0);
      // Создание аккаунта в PostgreSQL и сохранение сессии Redis не атомарны.
      expect(await prisma.user.count()).toBe(1);
    } finally {
      await observer.sendCommand(['ACL', 'SETUSER', 'default', '+set']);
    }
  });

  describe('POST /api/auth/sign-in', () => {
    const signInRoute = '/api/auth/sign-in';

    it('returns 200 and saves the existing user id in a new session', async () => {
      const user = await users.create(credentials.username, credentials.password);
      const response = await http().post(signInRoute).send(credentials)
        .expect(200, { username: credentials.username });
      expect(cookieFrom(response)).toMatch(/^sid=/);
      expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
      expect(response.headers['set-cookie'][0]).toContain('SameSite=Lax');
      const [key] = await observer.keys('sess:*');
      expect(JSON.parse((await observer.get(key)) ?? '{}')).toMatchObject({ userId: user.id });
      expect(await observer.ttl(key)).toBeGreaterThan(0);
      expect(await prisma.user.count()).toBe(1);
    });

    it.each([
      {},
      { username: 'ab', password: 'valid-password' },
      { username: 'User_1', password: 'valid-password' },
      { username: 'user_1', password: 'short' },
      { username: 'user_1', password: 'a'.repeat(65) },
      { username: 'user_1', password: 12345678 },
    ])('returns 400 for invalid input without creating users or sessions', async body => {
      const response = await http().post(signInRoute).send(body).expect(400);
      expect(response.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await observer.dbSize()).toBe(0);
      expect(await prisma.user.count()).toBe(0);
    });

    it('returns exactly the same 401 for an unknown username and wrong password', async () => {
      await users.create(credentials.username, credentials.password);
      const wrongPassword = await http().post(signInRoute)
        .send({ ...credentials, password: 'wrong-password' }).expect(401);
      const unknownUser = await http().post(signInRoute)
        .send({ ...credentials, username: 'unknown_user' }).expect(401);
      expect(wrongPassword.body).toEqual({
        statusCode: 401, error: 'Unauthorized', message: 'Invalid username or password',
      });
      expect(unknownUser.body).toEqual(wrongPassword.body);
      expect(wrongPassword.headers['set-cookie']).toBeUndefined();
      expect(unknownUser.headers['set-cookie']).toBeUndefined();
      expect(await observer.dbSize()).toBe(0);
      expect(await prisma.user.count()).toBe(1);
    });

    it('replaces the session id and removes the previous session on repeated sign-in', async () => {
      await users.create(credentials.username, credentials.password);
      const firstCookie = cookieFrom(await http().post(signInRoute).send(credentials).expect(200));
      const [oldKey] = await observer.keys('sess:*');
      const response = await http().post(signInRoute).set('Cookie', firstCookie)
        .send(credentials).expect(200);
      expect(cookieFrom(response)).not.toBe(firstCookie);
      expect(await observer.exists(oldKey)).toBe(0);
      expect(await observer.dbSize()).toBe(1);
    });

    it('does not change the password or replace an existing session after failed sign-in', async () => {
      const firstCookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      const [key] = await observer.keys('sess:*');
      await http().post(signInRoute).set('Cookie', firstCookie)
        .send({ ...credentials, password: 'wrong-password' }).expect(401);
      expect(await observer.exists(key)).toBe(1);
      expect(await observer.dbSize()).toBe(1);
      expect(await users.verifyCredentials(credentials.username, credentials.password)).not.toBeNull();
    });

    it('does not trim the password and takes userId only from the verified account', async () => {
      const password = '  password  ';
      const user = await users.create(credentials.username, password);
      await http().post(signInRoute).send({ ...credentials, password: 'password' }).expect(401);
      await http().post(signInRoute).send({ ...credentials, password, userId: 999999 }).expect(200);
      const [key] = await observer.keys('sess:*');
      expect(JSON.parse((await observer.get(key)) ?? '{}')).toMatchObject({ userId: user.id });
    });

    it('returns a standard 500 without leaking unexpected verification failures', async () => {
      vi.spyOn(users, 'verifyCredentials').mockRejectedValueOnce(new Error('sensitive-driver-detail'));
      const response = await http().post(signInRoute).send(credentials).expect(500);
      expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await observer.dbSize()).toBe(0);
    });

    it('returns 500 without a cookie if Redis refuses to save the session', async () => {
      await users.create(credentials.username, credentials.password);
      await observer.sendCommand(['ACL', 'SETUSER', 'default', '-set']);
      try {
        const response = await http().post(signInRoute).send(credentials).expect(500);
        expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(await observer.dbSize()).toBe(0);
        expect(await prisma.user.count()).toBe(1);
      } finally {
        await observer.sendCommand(['ACL', 'SETUSER', 'default', '+set']);
      }
    });
  });

  describe('GET /api/user/me', () => {
    const meRoute = '/api/user/me';

    it('returns 401 without a session before executing the controller', async () => {
      const lookup = vi.spyOn(users, 'findById');
      const response = await http().get(meRoute).expect(401);
      expect(response.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });

    it('returns only username after registration and after sign-in', async () => {
      const registrationCookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      await http().get(meRoute).set('Cookie', registrationCookie)
        .expect(200, { username: credentials.username });
      const loginCookie = cookieFrom(await http().post('/api/auth/sign-in').send(credentials).expect(200));
      await http().get(meRoute).set('Cookie', loginCookie)
        .expect(200, { username: credentials.username });
    });

    it('cannot select another user through a query parameter or header', async () => {
      const firstCookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      const secondCookie = cookieFrom(await http().post(route)
        .send({ ...credentials, username: 'second_user' }).expect(201));
      const second = await prisma.user.findUniqueOrThrow({ where: { username: 'second_user' } });
      await http().get(meRoute).query({ userId: second.id }).set('X-User-Id', String(second.id))
        .set('Cookie', firstCookie).expect(200, { username: credentials.username });
      await http().get(meRoute).set('Cookie', secondCookie).expect(200, { username: 'second_user' });
      await http().get(meRoute).query({ userId: second.id }).expect(401);
    });

    it('rejects a modified session signature', async () => {
      const cookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      const modified = cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A');
      await http().get(meRoute).set('Cookie', modified).expect(401);
    });

    it.each([0, -1, 1.5, '42', null])('rejects an invalid userId in a stored session', async userId => {
      const cookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      const [key] = await observer.keys('sess:*');
      const session = JSON.parse((await observer.get(key)) ?? '{}') as Record<string, unknown>;
      session.userId = userId;
      await observer.set(key, JSON.stringify(session), { EX: 60 });
      await http().get(meRoute).set('Cookie', cookie).expect(401);
    });

    it('returns 401 if the session exists but the database user no longer exists', async () => {
      const cookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      await prisma.user.deleteMany();
      await http().get(meRoute).set('Cookie', cookie).expect(401);
    });

    it('returns 401 when Redis no longer contains the session', async () => {
      const cookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      const [key] = await observer.keys('sess:*');
      await observer.del(key);
      await http().get(meRoute).set('Cookie', cookie).expect(401);
    });

    it('rejects the old cookie after repeated sign-in while accepting the new one', async () => {
      const oldCookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      const newCookie = cookieFrom(await http().post('/api/auth/sign-in').set('Cookie', oldCookie)
        .send(credentials).expect(200));
      await http().get(meRoute).set('Cookie', oldCookie).expect(401);
      await http().get(meRoute).set('Cookie', newCookie).expect(200, { username: credentials.username });
    });

    it('does not leak unexpected database failures', async () => {
      const cookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      vi.spyOn(users, 'findById').mockRejectedValueOnce(new Error('private-database-detail'));
      const response = await http().get(meRoute).set('Cookie', cookie).expect(500);
      expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    });

    it('protects a newly added endpoint without an explicit guard decorator', async () => {
      await http().get('/api/__protected_probe').expect(401);
      const cookie = cookieFrom(await http().post(route).send(credentials).expect(201));
      await http().get('/api/__protected_probe').set('Cookie', cookie).expect(200, { protected: true });
    });
  });
});

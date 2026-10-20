import { ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { verify } from 'argon2';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from './users.module.js';
import { UsersService } from './users.service.js';

const execFileAsync = promisify(execFile);

describe('UsersService with PostgreSQL', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let module: TestingModule | undefined;
  let users: UsersService;
  let prisma: PrismaService;

  beforeAll(async () => {
    // Отдельная БД и случайный порт: локальная база разработчика не затрагивается.
    container = await new PostgreSqlContainer('postgres:18.0-alpine').start();
    const databaseUrl = container.getConnectionUri();

    // Проверяем именно миграции из репозитория, а не prisma db push.
    await execFileAsync(process.execPath, [
      fileURLToPath(new URL('../../node_modules/prisma/build/index.js', import.meta.url)),
      'migrate', 'deploy', '--config', 'prisma.config.ts',
    ], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000,
    });

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          skipProcessEnv: true,
          load: [() => ({ DATABASE_URL: databaseUrl })],
        }),
        UsersModule,
      ],
    }).compile();
    await module.init();
    users = module.get(UsersService);
    prisma = module.get(PrismaService);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await module?.close();
    } finally {
      await container?.stop();
    }
  }, 30_000);

  it('stores an Argon2id hash and returns only safe fields', async () => {
    const password = 'Пароль пользователя 2026';
    const result = await users.create('new_user', password);
    const stored = await prisma.user.findUniqueOrThrow({ where: { username: 'new_user' } });

    expect(result).toEqual({ id: stored.id, username: 'new_user' });
    expect(stored.passwordHash).not.toBe(password);
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verify(stored.passwordHash, password)).toBe(true);
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  it('maps a duplicate username to ConflictException', async () => {
    await users.create('duplicate_user', 'first-password');
    await expect(users.create('duplicate_user', 'other-password'))
      .rejects.toThrow(ConflictException);
    expect(await users.verifyCredentials('duplicate_user', 'first-password')).not.toBeNull();
  });

  it('verifies passwords and returns null for both authentication failures', async () => {
    const created = await users.create('login_user', 'correct-password');
    expect(await users.verifyCredentials('login_user', 'correct-password')).toEqual(created);
    expect(await users.verifyCredentials('login_user', 'wrong-password')).toBeNull();
    expect(await users.verifyCredentials('unknown_user', 'correct-password')).toBeNull();
  });

  it('allows only one of two simultaneous registrations for the same username', async () => {
    const results = await Promise.allSettled([
      users.create('concurrent_user', 'same-password'),
      users.create('concurrent_user', 'same-password'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    expect(await prisma.user.count({ where: { username: 'concurrent_user' } })).toBe(1);
  });

  it('uses different salts for equal passwords', async () => {
    await users.create('salt_one', 'same-password');
    await users.create('salt_two', 'same-password');
    const first = await prisma.user.findUniqueOrThrow({ where: { username: 'salt_one' } });
    const second = await prisma.user.findUniqueOrThrow({ where: { username: 'salt_two' } });
    expect(first.passwordHash).not.toBe(second.passwordHash);
  });

  it('preserves unexpected database failures for the standard Nest error handler', async () => {
    const failure = new Error('Simulated database failure');
    vi.spyOn(prisma.user, 'create').mockRejectedValueOnce(failure);
    await expect(users.create('failed_user', 'valid-password')).rejects.toBe(failure);
  });
});

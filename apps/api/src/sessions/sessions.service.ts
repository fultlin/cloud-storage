import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisStore } from 'connect-redis';
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import session from 'express-session';
import { createClient, type RedisClientType } from 'redis';
import type { Env } from '../config/env.schema.js';

@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private readonly client: RedisClientType;
  private readonly cookieOptions: CookieOptions;
  readonly middleware: RequestHandler;

  constructor(config: ConfigService<Env, true>) {
    this.client = createClient({
      url: config.get('REDIS_URL', { infer: true }),
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        // Недоступный Redis не должен оставлять запуск API в бесконечном ожидании.
        reconnectStrategy: retries => retries >= 5
          ? new Error('Redis connection retries exhausted')
          : Math.min(100 * 2 ** retries, 1000),
      },
    });
    this.client.on('error', (error: Error) => this.logger.error('Redis connection error', error.stack));

    const ttlSeconds = config.get('SESSION_TTL_SECONDS', { infer: true });
    this.cookieOptions = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.get('COOKIE_SECURE', { infer: true }),
    };
    this.middleware = session({
      store: new RedisStore({ client: this.client, prefix: 'sess:', ttl: ttlSeconds }),
      name: 'sid',
      secret: config.get('SESSION_SECRET', { infer: true }),
      resave: false,
      saveUninitialized: false,
      // Продлеваем cookie вместе с TTL активной сессии в Redis.
      rolling: true,
      cookie: {
        ...this.cookieOptions,
        maxAge: ttlSeconds * 1000,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // Nest завершает инициализацию модулей до начала приёма HTTP-запросов.
    await this.client.connect();
  }

  async start(req: Request, userId: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      req.session.regenerate(error => error ? reject(error) : resolve());
    });

    // regenerate заменяет req.session: нельзя продолжать работу со старым объектом.
    req.session.userId = userId;
    try {
      await new Promise<void>((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
      });
    } catch (error: unknown) {
      // Не оставляем авторизованную сессию после неуспешного сохранения.
      await new Promise<void>(resolve => {
        req.session.destroy((cleanupError: Error | null) => {
          if (cleanupError) this.logger.error('Failed to clean up session', cleanupError.stack);
          resolve();
        });
      });
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.close();
    }
  }

  async end(req: Request, res: Response): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      req.session.destroy(error => error ? reject(error) : resolve());
    });
    // Одинаковые атрибуты cookie при установке и удалении, без maxAge.
    res.clearCookie('sid', this.cookieOptions);
  }
}

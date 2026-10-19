import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Env } from './config/env.schema.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  app.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen(config.get('PORT', { infer: true }));
}
await bootstrap();


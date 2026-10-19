import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { fileURLToPath } from 'node:url';
import { envSchema } from './config/env.schema.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Путь одинаков для src/app.module.ts и dist/app.module.js.
      envFilePath: fileURLToPath(new URL('../../../.env', import.meta.url)),
      validationSchema: envSchema,
      skipProcessEnv: true,
    }),
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

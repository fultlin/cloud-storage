import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';

@Module({
  imports: [UsersModule, SessionsModule],
  controllers: [AuthController],
})
export class AuthModule {}

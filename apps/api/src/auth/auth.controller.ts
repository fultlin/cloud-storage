import { credentialsSchema, type Credentials } from '@app/shared';
import { Body, Controller, HttpCode, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { SessionsService } from '../sessions/sessions.service.js';
import { UsersService } from '../users/users.service.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('sign-up')
  @Public()
  async signUp(
    @Body({ schema: credentialsSchema }) credentials: Credentials,
    @Req() req: Request,
  ): Promise<{ username: string }> {
    const user = await this.users.create(credentials.username, credentials.password);
    await this.sessions.start(req, user.id);
    // Контракт регистрации не раскрывает ни внутренний id, ни хеш пароля.
    return { username: user.username };
  }

  @Post('sign-in')
  @Public()
  @HttpCode(200)
  async signIn(
    @Body({ schema: credentialsSchema }) credentials: Credentials,
    @Req() req: Request,
  ): Promise<{ username: string }> {
    const user = await this.users.verifyCredentials(credentials.username, credentials.password);
    if (!user) {
      // Один ответ не позволяет различить неверный пароль и неизвестный username.
      throw new UnauthorizedException('Invalid username or password');
    }
    await this.sessions.start(req, user.id);
    return { username: user.username };
  }
}

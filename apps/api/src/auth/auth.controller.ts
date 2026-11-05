import { credentialsSchema, type Credentials } from '@app/shared';
import { Body, Controller, HttpCode, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { SessionsService } from '../sessions/sessions.service.js';
import { UsersService } from '../users/users.service.js';
import { Public } from './public.decorator.js';
import { ApiErrors, publicUserSchema, SESSION_SECURITY } from '../openapi.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('sign-up')
  @ApiCreatedResponse({ standardSchema: publicUserSchema })
  @ApiErrors(400, 409, 500)
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
  @ApiOkResponse({ standardSchema: publicUserSchema })
  @ApiErrors(400, 401, 500)
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

  @Post('sign-out')
  @ApiCookieAuth(SESSION_SECURITY)
  @ApiNoContentResponse({ description: 'Session ended' })
  @ApiErrors(401, 500)
  @HttpCode(204)
  async signOut(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.end(req, res);
  }
}

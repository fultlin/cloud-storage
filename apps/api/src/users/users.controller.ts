import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { UsersService } from './users.service.js';

@Controller('user')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  async me(@CurrentUserId() userId: number): Promise<{ username: string }> {
    const user = await this.users.findById(userId);
    // Сессия не подтверждает существование аккаунта после удаления записи БД.
    if (!user) throw new UnauthorizedException('Unauthorized');
    return { username: user.username };
  }
}

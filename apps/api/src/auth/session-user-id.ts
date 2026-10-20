import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

// Guard и параметр-декоратор используют одну проверку данных сессии.
export function getSessionUserId(req: Request): number {
  const userId = req.session?.userId;
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new UnauthorizedException('Unauthorized');
  }
  return userId;
}

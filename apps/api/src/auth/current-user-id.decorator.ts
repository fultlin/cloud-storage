import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { getSessionUserId } from './session-user-id.js';

export const CurrentUserId = createParamDecorator((_data: unknown, context: ExecutionContext): number => {
  return getSessionUserId(context.switchToHttp().getRequest<Request>());
});

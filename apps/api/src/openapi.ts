import { applyDecorators } from '@nestjs/common';
import { ApiResponse, DocumentBuilder, SwaggerModule, type SchemaObject } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { STATUS_CODES } from 'node:http';
import { z } from 'zod';
import { usernameSchema } from '@app/shared';

export const SESSION_SECURITY = 'session';
export const publicUserSchema = z.object({ username: usernameSchema });

export function ApiErrors(...statuses: number[]) {
  return applyDecorators(...statuses.map(status => {
    const text: SchemaObject = { type: 'string' };
    return ApiResponse({
      status,
      description: STATUS_CODES[status],
      schema: {
        type: 'object',
        required: status === 500 ? ['statusCode', 'message'] : ['statusCode', 'message', 'error'],
        properties: {
          statusCode: { type: 'integer', enum: [status] },
          message: status === 400 ? { oneOf: [text, { type: 'array', items: text }] } : text,
          error: text,
        },
      },
    });
  }));
}

export function configureOpenApi(app: NestExpressApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Cloud Storage API')
    .setVersion('1.0.0')
    .addCookieAuth('sid', { type: 'apiKey', in: 'cookie' }, SESSION_SECURITY)
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: '/api/docs-json', raw: ['json'],
  });
}

import { z } from 'zod';

const positiveInteger = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// В env все значения — строки. Boolean('false') дал бы true.
const booleanString = z.enum(['true', 'false']).transform(value => value === 'true');
const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });
const redisUrl = z.url({ protocol: /^rediss?$/ });
const httpUrl = z.url({ protocol: /^https?$/ });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: positiveInteger.max(65535),
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_SECONDS: positiveInteger.max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  COOKIE_SECURE: booleanString,
  TRUST_PROXY: booleanString,
  S3_ENDPOINT: httpUrl,
  S3_REGION: z.string().trim().min(1),
  S3_ACCESS_KEY_ID: z.string().trim().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.literal('user-files'),
  S3_FORCE_PATH_STYLE: booleanString,
  UPLOAD_MAX_FILE_SIZE_BYTES: positiveInteger.max(5 * 1024 ** 3),
  UPLOAD_MAX_FILES: positiveInteger,
  SWAGGER_ENABLED: booleanString,
});

// Тип выводится из результата схемы: PORT — number, COOKIE_SECURE — boolean.
export type Env = z.infer<typeof envSchema>;

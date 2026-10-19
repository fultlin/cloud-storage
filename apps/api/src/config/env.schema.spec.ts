import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { envSchema } from './env.schema.js';

const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));

describe('envSchema', () => {
  it('parses the documented local configuration into typed values', () => {
    const config = envSchema.parse(example);
    expect(config.PORT).toBe(3000);
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it.each(['falsee', '0', '', 'yes'])('rejects ambiguous boolean %j', value => {
    expect(envSchema.safeParse({ ...example, COOKIE_SECURE: value }).success).toBe(false);
  });

  it('identifies missing required variables', () => {
    const { SESSION_SECRET: _secret, ...withoutSecret } = example;
    const result = envSchema.safeParse(withoutSecret);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.path.join('.'))).toContain('SESSION_SECRET');
    }
  });

  it.each(['0', '-1', '1.5', '65536', ''])('rejects invalid port %j', value => {
    expect(envSchema.safeParse({ ...example, PORT: value }).success).toBe(false);
  });

  it('rejects uploads above 5 GiB and weak session secrets', () => {
    expect(envSchema.safeParse({ ...example, UPLOAD_MAX_FILE_SIZE_BYTES: '5368709121' }).success).toBe(false);
    expect(envSchema.safeParse({ ...example, SESSION_SECRET: 'short' }).success).toBe(false);
  });
});

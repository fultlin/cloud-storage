import { describe, expect, it } from 'vitest';
import { credentialsSchema, passwordSchema, usernameSchema } from '../src/auth.js';

describe('usernameSchema', () => {
  it.each(['abc', 'a'.repeat(32), 'user_2026', '123', '___'])('accepts %j', username => {
    expect(usernameSchema.parse(username)).toBe(username);
  });

  it.each([
    '', 'ab', 'a'.repeat(33), 'User', 'пользователь', 'user-name',
    'user.name', ' user', 'user ', 'user name', 'user\n',
  ])('rejects invalid username %j without silently correcting it', username => {
    expect(usernameSchema.safeParse(username).success).toBe(false);
  });
});

describe('passwordSchema', () => {
  it.each(['a'.repeat(8), 'a'.repeat(64), 'я'.repeat(64), '  secret  ', 'UPPERlower42'])
    ('accepts the password unchanged', password => {
      expect(passwordSchema.parse(password)).toBe(password);
    });

  it.each(['', 'a'.repeat(7), 'a'.repeat(65)])('rejects invalid length %j', password => {
    expect(passwordSchema.safeParse(password).success).toBe(false);
  });
});

describe('credentialsSchema', () => {
  it('parses the shared registration and sign-in contract', () => {
    const credentials = { username: 'user_1', password: 'valid-password' };
    expect(credentialsSchema.parse(credentials)).toEqual(credentials);
  });

  it.each([
    {}, null, [], 'user_1',
    { username: 'user_1' },
    { password: 'valid-password' },
    { username: 123, password: 'valid-password' },
    { username: 'user_1', password: 12345678 },
  ])('rejects missing fields and incorrect JSON types', body => {
    expect(credentialsSchema.safeParse(body).success).toBe(false);
  });

  it('does not pass additional input fields to application logic', () => {
    expect(credentialsSchema.parse({
      username: 'user_1', password: 'valid-password', userId: 42,
    })).toEqual({ username: 'user_1', password: 'valid-password' });
  });
});

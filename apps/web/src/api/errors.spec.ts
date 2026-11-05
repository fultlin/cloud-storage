import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './errors.js';

describe('Nest error messages', () => {
  it('keeps a string message', () => {
    expect(apiErrorMessage({ message: 'Username is already taken' }, 409)).toBe('Username is already taken');
  });
  it('joins array messages without stringifying objects', () => {
    expect(apiErrorMessage({ message: ['First', { secret: true }, '', 'Second'] }, 400)).toBe('First\nSecond');
  });
  it.each([null, '<html>proxy error</html>', {}, { message: {} }, { message: [] }])
    ('uses a safe fallback for %j', body => {
      expect(apiErrorMessage(body, 500)).toBe('Ошибка сервера. Попробуйте ещё раз.');
    });
});

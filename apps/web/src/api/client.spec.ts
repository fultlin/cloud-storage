import { QueryClient } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockHandlers } from '../mocks/handlers.js';
import { createApiClient } from './client.js';
import { createSessionExpiryHandler } from './query-client.js';

const server = setupServer();
const unauthorized = vi.fn();
const api = createApiClient({ onUnauthorized: unauthorized, fetch: (input, init) => fetch(new URL(String(input), 'http://localhost:5173'), init) });
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { server.resetHandlers(...createMockHandlers()); unauthorized.mockReset(); });
afterAll(() => server.close());

describe('HTTP client', () => {
  it('allows an initial 401 without redirecting, but redirects for a later protected request', async () => {
    await expect(api.initialUser()).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).not.toHaveBeenCalled();
    await expect(api.listDirectory('')).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
  });
  it('leaves incorrect credentials on the sign-in form', async () => {
    await expect(api.signIn({ username: 'demo_user', password: 'incorrect_password' })).rejects.toMatchObject({
      status: 401, message: 'Invalid username or password',
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('encodes API query paths once and accepts an empty 204 response', async () => {
    await api.signIn({ username: 'demo_user', password: 'demo_pass123' });
    await expect(api.listDirectory('100% #1?/')).resolves.toEqual([]);
    await expect(api.signOut()).resolves.toBeUndefined();
  });
  it('handles non-JSON HTTP errors and rejects malformed successful responses', async () => {
    server.use(http.get('*/api/user/me', () => new HttpResponse('<html>proxy error</html>', { status: 500 })));
    await expect(api.initialUser()).rejects.toMatchObject({ status: 500, message: 'Ошибка сервера. Попробуйте ещё раз.' });
    server.use(http.get('*/api/user/me', () => new HttpResponse('not json', { status: 200 })));
    await expect(api.initialUser()).rejects.toMatchObject({ status: 200, message: 'Сервер вернул некорректный ответ.' });
  });
  it('distinguishes a network failure from an aborted request', async () => {
    const client = createApiClient({ onUnauthorized: unauthorized, fetch: async () => { throw new TypeError('network'); } });
    await expect(client.currentUser()).rejects.toMatchObject({ status: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(api.currentUser(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(unauthorized).not.toHaveBeenCalled();
  });
  it('cancels and clears cached private data before redirecting, including concurrent 401s', async () => {
    const cache = new QueryClient();
    cache.setQueryData(['directory', ''], [{ name: 'Private document' }]);
    const redirect = vi.fn(() => expect(cache.getQueryCache().getAll()).toEqual([]));
    const expire = createSessionExpiryHandler(cache, () => '/files/100%25%20%231%3F/', redirect);
    await Promise.all([expire(), expire()]);
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/sign-in?returnTo=%2Ffiles%2F100%2525%2520%25231%253F%2F');
    expect(cache.getMutationCache().getAll()).toEqual([]);
  });
});

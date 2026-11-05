import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMockHandlers } from './handlers.js';

const server = setupServer();
const base = 'http://localhost:5173/api';
const credentials = { username: 'demo_user', password: 'demo_pass123' };
function post(path: string, body?: unknown) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => server.resetHandlers(...createMockHandlers()));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('mock API contract', () => {
  it('starts without a session and checks authentication before paths', async () => {
    expect((await fetch(base + '/user/me')).status).toBe(401);
    expect((await fetch(base + '/directory')).status).toBe(401);
    expect((await post('/auth/sign-out')).status).toBe(401);
  });
  it('signs in, lists direct children and signs out', async () => {
    const login = await post('/auth/sign-in', credentials);
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ username: 'demo_user' });
    expect(await (await fetch(base + '/user/me')).json()).toEqual({ username: 'demo_user' });
    const listing = await (await fetch(base + '/directory?path=')).json();
    expect(listing).toHaveLength(3);
    expect(listing.some((resource: { path: string }) => resource.path !== '')).toBe(false);
    expect((await post('/auth/sign-out')).status).toBe(204);
    expect((await fetch(base + '/user/me')).status).toBe(401);
  });
  it('does not distinguish an unknown username from an incorrect password', async () => {
    const unknown = await post('/auth/sign-in', { username: 'unknown', password: 'wrong_password' });
    const incorrect = await post('/auth/sign-in', { ...credentials, password: 'wrong_password' });
    expect(unknown.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(await unknown.json()).toEqual(await incorrect.json());
  });
  it('returns validation arrays and username conflicts', async () => {
    const invalid = await post('/auth/sign-up', { username: 'A', password: 'x' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).message).toEqual(expect.any(Array));
    expect((await post('/auth/sign-up', credentials)).status).toBe(409);
  });
  it('isolates a new account from the demo resources', async () => {
    const registered = await post('/auth/sign-up', { username: 'second_user', password: 'second_password' });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toEqual({ username: 'second_user' });
    expect(await (await fetch(base + '/directory?path=')).json()).toEqual([]);
    expect((await fetch(base + '/directory?path=' + encodeURIComponent('Документы/'))).status).toBe(404);
  });
  it('keeps special characters and distinguishes an empty folder from a missing one', async () => {
    await post('/auth/sign-in', credentials);
    expect(await (await fetch(base + '/directory?path=' + encodeURIComponent('100% #1?/'))).json()).toEqual([]);
    expect((await fetch(base + '/directory?path=missing%2F')).status).toBe(404);
    expect((await fetch(base + '/directory')).status).toBe(400);
    expect((await fetch(base + '/directory?path=..%2F')).status).toBe(400);
  });
  it('supports overriding a request with a server error for UI tests', async () => {
    server.use(http.get('*/api/user/me', () => HttpResponse.json({ statusCode: 500, message: 'Internal server error' }, { status: 500 })));
    expect((await fetch(base + '/user/me')).status).toBe(500);
  });
});

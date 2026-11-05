import { credentialsSchema, directoryOrRootPathSchema, resourcePathSchema } from '@app/shared';
import { http, HttpResponse } from 'msw';
import type { paths } from '../api/schema.js';

type Resource = paths['/api/resource']['get']['responses'][200]['content']['application/json'];
type PublicUser = paths['/api/user/me']['get']['responses'][200]['content']['application/json'];

// Development-only fixtures, never real user credentials or browser authentication.
const initialPassword = 'demo_pass123';

function error(status: number, message: string | string[]) {
  const names: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict', 500: 'Internal Server Error' };
  return HttpResponse.json({ statusCode: status, error: names[status], message }, { status });
}

function fullPath(resource: Resource): string {
  return resource.path + resource.name + (resource.type === 'DIRECTORY' ? '/' : '');
}

export function createMockHandlers() {
  const users = new Map([['demo_user', initialPassword]]);
  const resources = new Map<string, Resource[]>([['demo_user', [
    { path: '', name: 'Документы', type: 'DIRECTORY' },
    { path: '', name: '100% #1?', type: 'DIRECTORY' },
    { path: '', name: 'Прочитай меня.txt', type: 'FILE', size: 120 },
    { path: 'Документы/', name: 'Отчёт 2026.txt', type: 'FILE', size: 2048 },
  ]]]);
  let session: PublicUser | null = null;
  const owned = () => resources.get(session?.username ?? '') ?? [];

  return [
    http.post('*/api/auth/sign-up', async ({ request }) => {
      let body: unknown;
      try { body = await request.json(); } catch { return error(400, 'Invalid JSON'); }
      const credentials = credentialsSchema.safeParse(body);
      if (!credentials.success) return error(400, credentials.error.issues.map(issue => issue.message));
      const { username, password } = credentials.data;
      if (users.has(username)) return error(409, 'Username is already taken');
      users.set(username, password);
      resources.set(username, []);
      session = { username };
      return HttpResponse.json(session, { status: 201 });
    }),
    http.post('*/api/auth/sign-in', async ({ request }) => {
      let body: unknown;
      try { body = await request.json(); } catch { return error(400, 'Invalid JSON'); }
      const credentials = credentialsSchema.safeParse(body);
      if (!credentials.success) return error(400, credentials.error.issues.map(issue => issue.message));
      const { username, password } = credentials.data;
      if (users.get(username) !== password) return error(401, 'Invalid username or password');
      session = { username };
      return HttpResponse.json(session);
    }),
    http.post('*/api/auth/sign-out', () => {
      if (!session) return error(401, 'Unauthorized');
      session = null;
      return new HttpResponse(null, { status: 204 });
    }),
    http.get('*/api/user/me', () => session ? HttpResponse.json(session) : error(401, 'Unauthorized')),
    http.get('*/api/directory', ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const params = new URL(request.url).searchParams;
      if (params.getAll('path').length !== 1) return error(400, ['Expected one directory path']);
      const parsed = directoryOrRootPathSchema.safeParse(params.get('path'));
      if (!parsed.success) return error(400, ['Invalid directory path']);
      const path = parsed.data;
      if (path && !owned().some(resource => resource.type === 'DIRECTORY' && fullPath(resource) === path)) {
        return error(404, 'Directory does not exist');
      }
      return HttpResponse.json(owned().filter(resource => resource.path === path));
    }),
    http.get('*/api/resource', ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const params = new URL(request.url).searchParams;
      if (params.getAll('path').length !== 1) return error(400, ['Expected one resource path']);
      const parsed = resourcePathSchema.safeParse(params.get('path'));
      if (!parsed.success) return error(400, ['Invalid resource path']);
      const resource = owned().find(resource => fullPath(resource) === parsed.data);
      return resource ? HttpResponse.json(resource) : error(404, 'Resource not found');
    }),
  ];
}

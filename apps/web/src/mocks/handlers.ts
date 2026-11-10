import { credentialsSchema, createDirectoryQuerySchema, directoryOrRootPathSchema, filePathSchema, moveResourceQuerySchema, resourcePathSchema, searchResourcesQuerySchema } from '@app/shared';
import { zipSync } from 'fflate';
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
  const blobs = new Map<string, Blob>();
  const blobKey = (path: string) => `${session?.username}:${path}`;
  const directoryExists = (path: string) => path === '' || owned().some(resource => resource.type === 'DIRECTORY' && fullPath(resource) === path);
  const split = (path: string) => {
    const name = path.endsWith('/') ? path.slice(0, -1) : path;
    const index = name.lastIndexOf('/');
    return { path: name.slice(0, index + 1), name: name.slice(index + 1) };
  };

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
    http.post('*/api/directory', ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const parsed = createDirectoryQuerySchema.safeParse({ path: new URL(request.url).searchParams.get('path') });
      if (!parsed.success) return error(400, ['Invalid directory path']);
      const path = parsed.data.path;
      if (owned().some(resource => fullPath(resource) === path)) return error(409, 'Directory already exists');
      const location = split(path);
      if (!directoryExists(location.path)) return error(404, 'Parent directory does not exist');
      const resource: Resource = { ...location, type: 'DIRECTORY' };
      owned().push(resource);
      return HttpResponse.json(resource, { status: 201 });
    }),
    http.get('*/api/resource/search', ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const parsed = searchResourcesQuerySchema.safeParse({ query: new URL(request.url).searchParams.get('query') });
      if (!parsed.success) return error(400, ['Invalid search query']);
      const result = owned().filter(resource => resource.name.toLowerCase().includes(parsed.data.query.toLowerCase()))
        .sort((a, b) => fullPath(a) < fullPath(b) ? -1 : fullPath(a) > fullPath(b) ? 1 : 0);
      return HttpResponse.json(result);
    }),
    http.delete('*/api/resource', ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const parsed = resourcePathSchema.safeParse(new URL(request.url).searchParams.get('path'));
      if (!parsed.success) return error(400, ['Invalid resource path']);
      const path = parsed.data;
      if (!owned().some(resource => fullPath(resource) === path)) return error(404, 'Resource not found');
      const keep = owned().filter(resource => {
        const key = fullPath(resource);
        if (key === path || (path.endsWith('/') && key.startsWith(path))) { blobs.delete(blobKey(key)); return false; }
        return true;
      });
      resources.set(session.username, keep);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('*/api/resource/move', ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const params = new URL(request.url).searchParams;
      const parsed = moveResourceQuerySchema.safeParse({ from: params.get('from'), to: params.get('to') });
      if (!parsed.success) return error(400, ['Invalid move paths']);
      const { from, to } = parsed.data;
      const origin = split(from), destination = split(to);
      if (from === to || from.endsWith('/') !== to.endsWith('/') || (from.endsWith('/') && to.startsWith(from)) ||
        (origin.path !== destination.path && origin.name !== destination.name)) return error(400, 'Invalid move paths');
      const resource = owned().find(resource => fullPath(resource) === from);
      if (!resource) return error(404, 'Resource not found');
      if (!directoryExists(destination.path)) return error(404, 'Destination directory does not exist');
      if (owned().some(resource => fullPath(resource) === to)) return error(409, 'Destination already exists');
      const moved: Resource = { ...resource, ...destination };
      resources.set(session.username, owned().map(item => {
        const key = fullPath(item);
        if (key !== from && !(from.endsWith('/') && key.startsWith(from))) return item;
        const target = to + key.slice(from.length);
        const blob = blobs.get(blobKey(key));
        if (blob) { blobs.set(blobKey(target), blob); blobs.delete(blobKey(key)); }
        return { ...item, ...split(target) };
      }));
      return HttpResponse.json(moved);
    }),
    http.post('*/api/resource', async ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const destination = directoryOrRootPathSchema.safeParse(new URL(request.url).searchParams.get('path'));
      if (!destination.success) return error(400, ['Invalid upload destination']);
      if (!directoryExists(destination.data)) return error(400, 'Upload directory does not exist');
      let form: FormData;
      try { form = await request.formData(); } catch { return error(400, 'Expected multipart/form-data'); }
      const entries = Array.from(form.entries());
      if (!entries.length || entries.length > 100 || entries.some(([field, file]) => field !== 'files' || typeof file === 'string')) return error(400, 'Expected files');
      const staged: { resource: Resource; blob: Blob; key: string }[] = [];
      const seen = new Set<string>();
      const directories = new Map<string, Resource>();
      for (const [, file] of entries) {
        if (typeof file === 'string') return error(400, 'Expected a file');
        const name = filePathSchema.safeParse(file.name);
        const path = filePathSchema.safeParse(destination.data + file.name);
        if (!name.success || !path.success || file.size > 5 * 1024 ** 3) return error(400, 'Invalid file path or size');
        if (seen.has(path.data) || owned().some(resource => fullPath(resource) === path.data)) return error(409, 'File already exists');
        seen.add(path.data);
        const location = split(path.data);
        let parent = location.path;
        while (parent && !directoryExists(parent)) {
          const directory: Resource = { ...split(parent), type: 'DIRECTORY' };
          directories.set(parent, directory); parent = directory.path;
        }
        staged.push({ resource: { ...location, size: file.size, type: 'FILE' }, blob: file, key: path.data });
      }
      owned().push(...directories.values(), ...staged.map(file => file.resource));
      for (const file of staged) blobs.set(blobKey(file.key), file.blob);
      return HttpResponse.json(staged.map(file => file.resource), { status: 201 });
    }),
    http.get('*/api/resource/download', async ({ request }) => {
      if (!session) return error(401, 'Unauthorized');
      const parsed = resourcePathSchema.safeParse(new URL(request.url).searchParams.get('path'));
      if (!parsed.success) return error(400, ['Invalid resource path']);
      const resource = owned().find(resource => fullPath(resource) === parsed.data);
      if (!resource) return error(404, 'Resource not found');
      let body: ArrayBuffer;
      const name = resource.name + (resource.type === 'DIRECTORY' ? '.zip' : '');
      if (resource.type === 'FILE') {
        body = await (blobs.get(blobKey(parsed.data)) ?? new Blob(['Демонстрационный файл'])).arrayBuffer();
      } else {
        const entries: Record<string, Uint8Array> = {};
        for (const child of owned().filter(child => fullPath(child).startsWith(parsed.data) && fullPath(child) !== parsed.data)) {
          const key = fullPath(child);
          entries[key.slice(parsed.data.length)] = child.type === 'DIRECTORY' ? new Uint8Array() : new Uint8Array(await (blobs.get(blobKey(key)) ?? new Blob(['Демонстрационный файл'])).arrayBuffer());
        }
        body = new Uint8Array(zipSync(entries)).buffer;
      }
      return new HttpResponse(body, { headers: { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}` } });
    }),
  ];
}

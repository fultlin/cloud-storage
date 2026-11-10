import type { paths } from './schema.js';
import { ApiError, apiErrorMessage } from './errors.js';

type Credentials = paths['/api/auth/sign-in']['post']['requestBody']['content']['application/json'];
type User = paths['/api/user/me']['get']['responses'][200]['content']['application/json'];
type Resources = paths['/api/directory']['get']['responses'][200]['content']['application/json'];
type Resource = paths['/api/resource']['get']['responses'][200]['content']['application/json'];

interface ClientOptions {
  onUnauthorized: () => void | Promise<void>;
  fetch?: typeof fetch;
}

export function createApiClient(options: ClientOptions) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, ignoreUnauthorized = false): Promise<T> {
    let response: Response;
    try {
      response = await send(path, {
        method, signal,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      throw new ApiError(0, 'Нет соединения с сервером. Проверьте сеть и повторите запрос.');
    }
    if (response.status === 401 && !ignoreUnauthorized) await options.onUnauthorized();
    let payload: unknown;
    if (response.status !== 204) {
      try { payload = await response.json(); } catch {
        if (response.ok) throw new ApiError(response.status, 'Сервер вернул некорректный ответ.');
      }
    }
    if (!response.ok) throw new ApiError(response.status, apiErrorMessage(payload, response.status));
    return payload as T;
  }
  return {
    signIn: (credentials: Credentials, signal?: AbortSignal) => request<User>('/api/auth/sign-in', 'POST', credentials, signal, true),
    signUp: (credentials: Credentials, signal?: AbortSignal) => request<User>('/api/auth/sign-up', 'POST', credentials, signal),
    signOut: (signal?: AbortSignal) => request<void>('/api/auth/sign-out', 'POST', undefined, signal),
    currentUser: (signal?: AbortSignal) => request<User>('/api/user/me', 'GET', undefined, signal),
    initialUser: (signal?: AbortSignal) => request<User>('/api/user/me', 'GET', undefined, signal, true),
    listDirectory: (path: string, signal?: AbortSignal) => request<Resources>('/api/directory?' + new URLSearchParams({ path }), 'GET', undefined, signal),
    resource: (path: string, signal?: AbortSignal) => request<Resource>('/api/resource?' + new URLSearchParams({ path }), 'GET', undefined, signal),
    search: (query: string, signal?: AbortSignal) => request<Resources>('/api/resource/search?' + new URLSearchParams({ query }), 'GET', undefined, signal),
    createDirectory: (path: string) => request<Resource>('/api/directory?' + new URLSearchParams({ path }), 'POST'),
    move: (from: string, to: string) => request<Resource>('/api/resource/move?' + new URLSearchParams({ from, to }), 'POST'),
    remove: (path: string) => request<void>('/api/resource?' + new URLSearchParams({ path }), 'DELETE'),
  };
}

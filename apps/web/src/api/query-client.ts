import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './errors.js';

export const queryClient = new QueryClient({ defaultOptions: {
  queries: { retry: (attempt, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && attempt < 1 },
  mutations: { retry: false },
} });

export function createSessionExpiryHandler(client: QueryClient, returnTo: () => string, redirect: (url: string) => void) {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const destination = returnTo();
      await client.cancelQueries();
      client.clear();
      redirect('/sign-in?' + new URLSearchParams({ returnTo: destination }));
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

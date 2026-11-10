import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import { api } from '../api/index.js';
import { ApiError } from '../api/errors.js';

export function useSession() {
  return useQuery({ queryKey: ['session'], staleTime: Infinity, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      try { return await api.initialUser(signal); }
      catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
    },
  });
}

export function SessionBoundary() {
  const session = useSession();
  if (session.isPending) return <p role="status">Проверяем сессию…</p>;
  if (session.isError) return <section><h1>Не удалось подключиться</h1><p role="alert">{session.error.message}</p><button onClick={() => void session.refetch()}>Повторить</button></section>;
  return <Outlet />;
}

export function ProtectedRoutes() {
  const { data } = useSession();
  const location = useLocation();
  if (!data) return <Navigate to={'/sign-in?' + new URLSearchParams({ returnTo: location.pathname + location.search })} replace />;
  return <Outlet />;
}

export function PublicRoutes() {
  const { data } = useSession();
  if (data) return <Navigate to="/files/" replace />;
  return <Outlet />;
}

export function MissingPage() {
  return <section><h1>Страница не найдена</h1><Link to="/files/">К файлам</Link></section>;
}

export function safeReturnTo(value: string | null): string {
  if (!value || value.includes('\\') || Array.from(value).some(char => char.charCodeAt(0) < 32)) return '/files/';
  return value.startsWith('/files/') || value === '/files' || value.startsWith('/search?') || value === '/search' ? value : '/files/';
}

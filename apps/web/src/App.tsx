import { useEffect, useState } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from './api/index.js';
import { queryClient } from './api/query-client.js';
import { AuthPage } from './auth/AuthPage.js';
import { MissingPage, ProtectedRoutes, PublicRoutes, SessionBoundary, useSession } from './auth/session.js';
import { FilesPage } from './files/FilesPage.js';
import { SearchPage } from './files/SearchPage.js';
import './App.css';

function SearchBox() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname === '/search' ? params.get('query') ?? '' : '';
  const [value, setValue] = useState(current);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    // Synchronize browser back/forward navigation with the editable search draft.
    // oxlint-disable-next-line react/set-state-in-effect
    setValue(current); setEdited(false);
  }, [current, location.pathname]);
  useEffect(() => {
    if (!edited) return;
    const timer = setTimeout(() => {
      const query = value.trim();
      navigate(query ? '/search?' + new URLSearchParams({ query }) : '/search', { replace: location.pathname === '/search' });
    }, 350);
    return () => clearTimeout(timer);
  }, [value, edited, navigate, location.pathname]);
  return <form role="search" className="search-form" onSubmit={event => {
    event.preventDefault(); setEdited(false);
    const query = value.trim(); navigate(query ? '/search?' + new URLSearchParams({ query }) : '/search');
  }}><label className="sr-only" htmlFor="search">Поиск по имени</label>
    <input id="search" type="search" maxLength={100} placeholder="Найти файл или папку" value={value} onChange={event => { setValue(event.target.value); setEdited(true); }} />
    <button aria-label="Найти">Найти</button>
  </form>;
}

function Layout() {
  const session = useSession();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function logout() {
    setError(''); setPending(true);
    try {
      await api.signOut(); await queryClient.cancelQueries(); queryClient.clear();
      queryClient.setQueryData(['session'], null); navigate('/sign-in', { replace: true });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось выйти.'); }
    finally { setPending(false); }
  }
  return <div className="app-shell"><header className="app-header">
    <Link className="brand" to="/files/"><span className="brand-symbol" aria-hidden="true">☁</span> Облако</Link>
    {session.data && <SearchBox />}
    <nav aria-label="Основная навигация">{session.data ? <>
      <Link to="/files/">Мои файлы</Link><span className="username">{session.data.username}</span>
      <button onClick={() => void logout()} disabled={pending}>{pending ? 'Выходим…' : 'Выйти'}</button>
    </> : <><Link to="/sign-in">Вход</Link><Link to="/sign-up">Регистрация</Link></>}</nav>
  </header>
    {error && <p className="error" role="alert">{error}</p>}
    <main><Outlet /></main><footer className="app-footer">Облако · Ваше пространство для файлов</footer>
  </div>;
}

export function AppRoutes() {
  return <Routes><Route element={<SessionBoundary />}><Route element={<Layout />}>
    <Route index element={<Navigate to="/files/" replace />} />
    <Route element={<PublicRoutes />}>
      <Route path="sign-in" element={<AuthPage />} />
      <Route path="sign-up" element={<AuthPage register />} />
    </Route>
    <Route element={<ProtectedRoutes />}>
      <Route path="files/*" element={<FilesPage />} />
      <Route path="search" element={<SearchPage />} />
    </Route>
    <Route path="*" element={<MissingPage />} />
  </Route></Route></Routes>;
}

export default AppRoutes;

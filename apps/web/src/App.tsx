import { Link, Navigate, Outlet, Route, Routes, useLocation, useSearchParams } from 'react-router';
import { folderPathFromUrl, folderUrl } from './routing/paths.js';
import './App.css';

function Layout() {
  return <div className="app-shell">
    <header className="app-header">
      <Link className="brand" to="/files/">Облако</Link>
      <nav aria-label="Основная навигация">
        <Link to="/files/">Файлы</Link><Link to="/sign-in">Войти</Link><Link to="/sign-up">Регистрация</Link>
      </nav>
    </header>
    <main><Outlet /></main>
  </div>;
}

function FilesPage() {
  const { pathname } = useLocation();
  if (pathname === '/files') return <Navigate to="/files/" replace />;
  let path: string;
  try {
    // Read the encoded location rather than Router's already decoded splat parameter.
    path = folderPathFromUrl(pathname);
  } catch {
    return <section><h1>Некорректный путь</h1><Link to="/files/">Перейти в корень</Link></section>;
  }
  const segments = path ? path.slice(0, -1).split('/') : [];
  return <section>
    <nav className="breadcrumbs" aria-label="Путь к папке">
      <Link to="/files/">Мои файлы</Link>
      {segments.map((segment, index) => {
        const parent = segments.slice(0, index + 1).join('/') + '/';
        return <span key={parent}><span aria-hidden="true"> / </span><Link to={folderUrl(parent)}>{segment}</Link></span>;
      })}
    </nav>
    <h1>{segments.at(-1) ?? 'Мои файлы'}</h1>
    <p className="notice">Содержимое папки пока не загружено.</p>
  </section>;
}

function SearchPage() {
  const [params] = useSearchParams();
  const query = params.get('query')?.trim() ?? '';
  return <section><h1>Поиск</h1><p>{query ? `Запрос: ${query}` : 'Введите имя файла или папки.'}</p></section>;
}

export function AppRoutes() {
  return <Routes><Route element={<Layout />}>
    <Route index element={<Navigate to="/files/" replace />} />
    <Route path="sign-in" element={<section><h1>Вход</h1><p>Войдите, чтобы открыть свои файлы.</p><Link to="/sign-up">Создать аккаунт</Link></section>} />
    <Route path="sign-up" element={<section><h1>Регистрация</h1><p>Создайте аккаунт для хранения файлов.</p><Link to="/sign-in">Уже есть аккаунт</Link></section>} />
    <Route path="files/*" element={<FilesPage />} />
    <Route path="search" element={<SearchPage />} />
    <Route path="*" element={<section><h1>Страница не найдена</h1><Link to="/files/">К файлам</Link></section>} />
  </Route></Routes>;
}

export default AppRoutes;

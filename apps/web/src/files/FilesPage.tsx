import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { api } from '../api/index.js';
import { ApiError } from '../api/errors.js';
import { folderPathFromUrl, folderUrl } from '../routing/paths.js';
import { ActionDialog } from './ActionDialog.js';
import { ResourceList } from './ResourceList.js';
import { UploadPanel } from './UploadPanel.js';

export function FilesPage() {
  const { pathname } = useLocation();
  if (pathname === '/files') return <Navigate to="/files/" replace />;
  let path: string;
  try { path = folderPathFromUrl(pathname); }
  catch { return <section><h1>Некорректный путь</h1><Link to="/files/">Перейти в корень</Link></section>; }
  return <Directory key={path} path={path} />;
}

function Directory({ path }: { path: string }) {
  const [creating, setCreating] = useState(false);
  const query = useQuery({ queryKey: ['resources', 'directory', path], queryFn: ({ signal }) => api.listDirectory(path, signal) });
  const segments = path ? path.slice(0, -1).split('/') : [];
  return <section>
    <nav className="breadcrumbs" aria-label="Путь к папке"><Link to="/files/">Мои файлы</Link>
      {segments.map((segment, index) => <span key={index}><span aria-hidden="true"> / </span><Link to={folderUrl(segments.slice(0, index + 1).join('/') + '/')}>{segment}</Link></span>)}
    </nav>
    <div className="page-heading"><h1>{segments.at(-1) ?? 'Мои файлы'}</h1>
      {query.isSuccess && <button className="primary" onClick={() => setCreating(true)}>Новая папка</button>}</div>
    {query.isPending && <p role="status">Загружаем содержимое…</p>}
    {query.isError && <div role="alert" className="error">
      <h2>{query.error instanceof ApiError && query.error.status === 404 ? 'Папка не найдена' : 'Не удалось загрузить папку'}</h2>
      <p>{query.error.message}</p><Link to="/files/">Перейти в корень</Link> <button onClick={() => void query.refetch()}>Повторить</button>
    </div>}
    {query.isSuccess && <>
      <UploadPanel path={path} />
      {!query.data.length ? <div className="empty-state"><h2>Папка пуста</h2><p>Загрузите файлы или создайте папку.</p></div> : <ResourceList resources={query.data} />}
      <div className="list-footer"><span>{query.data.length} элементов</span><button onClick={() => void query.refetch()} disabled={query.isFetching}>Обновить список</button></div>
    </>}
    {creating && <ActionDialog action={{ kind: 'create', path }} close={() => setCreating(false)} />}
  </section>;
}

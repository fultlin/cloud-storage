import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/index.js';
import { folderUrl } from '../routing/paths.js';
import { ActionDialog, type Action } from './ActionDialog.js';
import { formatSize, resourcePath, type Resource } from './resources.js';

export function ResourceList({ resources, search = false }: { resources: Resource[]; search?: boolean }) {
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState<string | null>(null);
  async function download(resource: Resource) {
    setError(''); setDownloading(resourcePath(resource));
    try {
      await api.currentUser();
      window.location.assign('/api/resource/download?' + new URLSearchParams({ path: resourcePath(resource) }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось скачать.'); }
    finally { setDownloading(null); }
  }
  return <>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="table-scroll"><table><caption className="sr-only">{search ? 'Результаты поиска' : 'Содержимое папки'}</caption>
      <thead><tr><th>Имя</th><th>{search ? 'Расположение' : 'Тип'}</th><th>Размер</th><th>Действия</th></tr></thead>
      <tbody>{resources.map(resource => {
        const full = resourcePath(resource);
        return <tr key={resource.type + ':' + full}>
          <td><span className={'resource-icon ' + resource.type.toLowerCase()} aria-hidden="true">{resource.type === 'DIRECTORY' ? '▰' : '▤'}</span>
            {resource.type === 'DIRECTORY' ? <Link to={folderUrl(full)}>{resource.name}</Link> : search ? <Link to={folderUrl(resource.path)}>{resource.name}</Link> : <span>{resource.name}</span>}</td>
          <td data-label={search ? 'Расположение' : 'Тип'}>{search ? <Link to={folderUrl(resource.path)}>{resource.path || 'Мои файлы'}</Link> : resource.type === 'DIRECTORY' ? 'Папка' : 'Файл'}</td>
          <td data-label="Размер">{resource.type === 'FILE' ? formatSize(resource.size) : '—'}</td>
          <td><div className="row-actions" aria-label={'Действия: ' + resource.name}>
            <button disabled={downloading !== null} onClick={() => void download(resource)}>{downloading === full ? 'Проверяем…' : 'Скачать'}</button>
            <button onClick={() => setAction({ kind: 'rename', resource })}>Переименовать</button>
            <button onClick={() => setAction({ kind: 'move', resource })}>Переместить</button>
            <button className="text-danger" onClick={() => setAction({ kind: 'delete', resource })}>Удалить</button>
          </div></td>
        </tr>;
      })}</tbody>
    </table></div>
    {action && <ActionDialog action={action} close={() => setAction(null)} />}
  </>;
}

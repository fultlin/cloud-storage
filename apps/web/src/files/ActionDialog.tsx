import { resourceNameSchema } from '@app/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api/index.js';
import { queryClient } from '../api/query-client.js';
import { resourcePath, type Resource } from './resources.js';

export type Action = { kind: 'create'; path: string } | { kind: 'rename' | 'move' | 'delete'; resource: Resource };

export function ActionDialog({ action, close }: { action: Action; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(action.kind === 'create' ? '' : action.resource.name);
  const [destination, setDestination] = useState(action.kind === 'create' ? action.path : action.resource.path);
  const [validation, setValidation] = useState('');
  const title = { create: 'Новая папка', rename: 'Переименовать', move: 'Переместить', delete: 'Удалить ресурс?' }[action.kind];
  useEffect(() => { dialog.current?.showModal(); }, []);
  const folders = useQuery({ queryKey: ['resources', 'directory', destination],
    queryFn: ({ signal }) => api.listDirectory(destination, signal), enabled: action.kind === 'move',
  });
  const mutation = useMutation({ mutationFn: async () => {
    if (action.kind === 'delete') return api.remove(resourcePath(action.resource));
    if (action.kind === 'move') return api.move(resourcePath(action.resource), destination + action.resource.name + (action.resource.type === 'DIRECTORY' ? '/' : ''));
    const parsed = resourceNameSchema.safeParse(name);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Проверьте имя.');
    if (action.kind === 'create') return api.createDirectory(action.path + parsed.data + '/');
    return api.move(resourcePath(action.resource), action.resource.path + parsed.data + (action.resource.type === 'DIRECTORY' ? '/' : ''));
  }, onSuccess: async () => {
    await queryClient.invalidateQueries({ queryKey: ['resources'] }); close();
  } });
  function submit(event: FormEvent) {
    event.preventDefault(); setValidation('');
    if (action.kind === 'create' || action.kind === 'rename') {
      const parsed = resourceNameSchema.safeParse(name);
      if (!parsed.success) { setValidation(parsed.error.issues[0]?.message ?? 'Проверьте имя.'); return; }
    }
    mutation.mutate();
  }
  const parent = destination.slice(0, -1).split('/').slice(0, -1).join('/');
  const error = validation || mutation.error?.message;
  return <dialog ref={dialog} aria-labelledby="action-title" onCancel={event => { if (mutation.isPending) event.preventDefault(); else close(); }}>
    <h2 id="action-title">{title}</h2>
    <form onSubmit={submit}>
      {(action.kind === 'create' || action.kind === 'rename') && <>
        <label htmlFor="resource-name">Имя {action.kind === 'create' ? 'папки' : 'ресурса'}</label>
        <input id="resource-name" autoFocus value={name} disabled={mutation.isPending} onChange={event => setName(event.target.value)} aria-invalid={!!error} />
      </>}
      {action.kind === 'delete' && <p>«{action.resource.name}»{action.resource.type === 'DIRECTORY' ? ' и всё содержимое папки' : ''} будет удалено без возможности восстановления.</p>}
      {action.kind === 'move' && <div className="folder-picker">
        <p>Куда: <strong>{destination || 'Мои файлы'}</strong></p>
        <div className="button-row"><button type="button" disabled={mutation.isPending || !destination} onClick={() => setDestination('')}>В корень</button>
          <button type="button" disabled={mutation.isPending || !destination} onClick={() => setDestination(parent ? parent + '/' : '')}>На уровень выше</button></div>
        {folders.isPending && <p role="status">Загружаем папки…</p>}
        {folders.isError && <p role="alert">{folders.error.message} <button type="button" onClick={() => void folders.refetch()}>Повторить</button></p>}
        <ul>{folders.data?.filter(resource => resource.type === 'DIRECTORY' &&
          !(action.resource.type === 'DIRECTORY' && resourcePath(resource).startsWith(resourcePath(action.resource))))
          .map(resource => <li key={resourcePath(resource)}><button type="button" disabled={mutation.isPending} onClick={() => setDestination(resourcePath(resource))}>Папка: {resource.name}</button></li>)}</ul>
        {folders.isSuccess && !folders.data.some(resource => resource.type === 'DIRECTORY') && <p className="muted">Вложенных папок нет.</p>}
        <p className="muted">Будет выбрана текущая открытая папка.</p>
      </div>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="button-row dialog-footer">
        <button type="button" disabled={mutation.isPending} onClick={close}>Отмена</button>
        <button className={action.kind === 'delete' ? 'danger' : 'primary'} disabled={mutation.isPending || (action.kind === 'move' && (!folders.isSuccess || destination === action.resource.path))}>
          {mutation.isPending ? 'Выполняем…' : action.kind === 'delete' ? 'Удалить' : action.kind === 'move' ? 'Переместить сюда' : 'Сохранить'}
        </button>
      </div>
    </form>
  </dialog>;
}

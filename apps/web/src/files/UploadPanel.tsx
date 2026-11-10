import { useEffect, useRef, useState } from 'react';
import { queryClient } from '../api/query-client.js';
import { uploadFiles } from '../api/upload.js';
import { ApiError } from '../api/errors.js';

export function UploadPanel({ path }: { path: string }) {
  const controller = useRef<AbortController | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [percent, setPercent] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); return () => controller.current?.abort(); }, []);
  async function upload(files: File[]) {
    if (!files.length || pending) return;
    controller.current = new AbortController(); setPercent(0); setMessage(''); setPending(true);
    try {
      await uploadFiles(path, files, setPercent, controller.current.signal);
      setMessage(`Загружено файлов: ${files.length}`);
    } catch (error) {
      setMessage(error instanceof DOMException && error.name === 'AbortError'
        ? 'Загрузка отменена. Обновите список после завершения отмены.'
        : `${error instanceof Error ? error.message : 'Ошибка загрузки.'} ${error instanceof ApiError && [400, 409].includes(error.status)
          ? 'Файлы этого запроса не загружены.' : 'Запрос не завершён. Обновите список перед повтором.'}`);
    } finally {
      setPending(false); controller.current = null;
      await queryClient.invalidateQueries({ queryKey: ['resources'] });
    }
  }
  return <div className="upload-panel">
    <div className="button-row">
      <label className={'upload-label' + (pending ? ' disabled' : '')}>Загрузить файлы<input type="file" multiple disabled={pending} onChange={event => {
        const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files);
      }} /></label>
      <label className={'upload-label' + (pending ? ' disabled' : '')}>Загрузить папку<input ref={folderInput} type="file" multiple disabled={pending} onChange={event => {
        const files = Array.from(event.target.files ?? []); event.target.value = ''; void upload(files);
      }} /></label>
    </div>
    {pending && <div role="status"><label>Загрузка: {percent}% <progress value={percent} max={100} /></label><button type="button" onClick={() => controller.current?.abort()}>Отменить загрузку</button></div>}
    {message && <p role="status" className="notice">{message}</p>}
    <small>При выборе папки браузер передаёт только файлы. Пустые папки не загружаются.</small>
  </div>;
}

import type { paths } from './schema.js';
import { ApiError, apiErrorMessage } from './errors.js';
import { handleUnauthorized } from './index.js';

export type UploadResult = paths['/api/resource']['post']['responses'][201]['content']['application/json'];

export function uploadFiles(path: string, files: File[], progress: (percent: number) => void, signal: AbortSignal): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
    const request = new XMLHttpRequest();
    const data = new FormData();
    for (const file of files) data.append('files', file, file.webkitRelativePath || file.name);
    request.open('POST', '/api/resource?' + new URLSearchParams({ path }));
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    request.onloadend = () => signal.removeEventListener('abort', abort);
    request.upload.onprogress = event => {
      if (event.lengthComputable) progress(Math.min(99, Math.round(event.loaded / event.total * 100)));
    };
    request.onerror = () => reject(new ApiError(0, 'Не удалось загрузить файлы. Проверьте соединение.'));
    request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    request.onload = async () => {
      let body: unknown;
      try { body = JSON.parse(request.responseText); } catch { /* Use the safe fallback below. */ }
      if (request.status === 401) await handleUnauthorized();
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(request.status, apiErrorMessage(body, request.status)));
      } else if (!Array.isArray(body)) {
        reject(new ApiError(request.status, 'Сервер вернул некорректный ответ загрузки.'));
      } else {
        progress(100);
        resolve(body as UploadResult);
      }
    };
    request.send(data);
  });
}

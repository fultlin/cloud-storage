import { searchResourcesQuerySchema } from '@app/shared';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../api/index.js';
import { ResourceList } from './ResourceList.js';

export function SearchPage() {
  const [params] = useSearchParams();
  const parsed = searchResourcesQuerySchema.safeParse({ query: params.get('query') });
  const query = parsed.success ? parsed.data.query : '';
  const results = useQuery({ queryKey: ['resources', 'search', query], enabled: !!query,
    queryFn: ({ signal }) => api.search(query, signal),
  });
  return <section><h1>Поиск</h1>
    {!query ? <p>Введите от 1 до 100 символов в строке поиска.</p> : <>
      <p className="muted">Результаты для «{query}»</p>
      {results.isPending && <p role="status">Ищем файлы и папки…</p>}
      {results.isError && <p role="alert" className="error">{results.error.message} <button onClick={() => void results.refetch()}>Повторить</button></p>}
      {results.isSuccess && (results.data.length ? <ResourceList resources={results.data} search /> : <div className="empty-state"><h2>Ничего не найдено</h2><p>Попробуйте другое имя.</p></div>)}
    </>}
  </section>;
}

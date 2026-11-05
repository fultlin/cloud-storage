import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from './App.js';

describe('application routes', () => {
  it('reads encoded location without decoding the splat a second time', () => {
    const page = renderToString(<MemoryRouter initialEntries={['/files/100%25%20%231%3F/%252E%252E/']}>
      <AppRoutes />
    </MemoryRouter>);
    expect(page).toContain('100% #1?');
    expect(page).toContain('<h1>%2E%2E</h1>');
    expect(page).toContain('href="/files/100%25%20%231%3F/"');
  });

  it.each([['/sign-in', 'Вход'], ['/sign-up', 'Регистрация'], ['/files/', 'Мои файлы'], ['/search?query=report', 'Запрос: report'], ['/unknown', 'Страница не найдена']])
    ('renders %s', (path, title) => {
      const page = renderToString(<MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter>);
      expect(page).toContain(title);
    });
});

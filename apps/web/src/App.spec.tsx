// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5173"}
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from './api/query-client.js';
import { createMockHandlers } from './mocks/handlers.js';
import { AppRoutes } from './App.js';
import { safeReturnTo } from './auth/session.js';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  const intercepted = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => intercepted(
    typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin) : input, init,
  ));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
});
beforeEach(() => { queryClient.clear(); server.resetHandlers(...createMockHandlers()); });
afterEach(() => { cleanup(); queryClient.clear(); });
afterAll(() => { vi.unstubAllGlobals(); server.close(); });

function app(path = '/files/') {
  render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[path]}><AppRoutes /></MemoryRouter></QueryClientProvider>);
  return userEvent.setup();
}
async function login(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('heading', { name: 'Вход в Облако' });
  await user.type(screen.getByLabelText('Имя пользователя'), 'demo_user');
  await user.type(screen.getByLabelText('Пароль'), 'demo_pass123');
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

describe('frontend user flows', () => {
  it('does not flash a sign-in form or private files while checking the session', async () => {
    server.use(http.get('*/api/user/me', async () => { await delay(80); return HttpResponse.json({ statusCode: 401, message: 'Unauthorized' }, { status: 401 }); }));
    app();
    expect(screen.getByRole('status').textContent).toContain('Проверяем сессию');
    expect(screen.queryByLabelText('Пароль')).toBeNull();
    expect(screen.queryByText('Прочитай меня.txt')).toBeNull();
    await screen.findByLabelText('Пароль');
  });
  it('returns to the requested Unicode folder after sign-in and shows 404 instead of an empty listing', async () => {
    const user = app('/files/100%25%20%231%3F/');
    await login(user);
    await screen.findByRole('heading', { name: '100% #1?' });
    await screen.findByRole('heading', { name: 'Папка пуста' });
  });
  it('shows a missing folder with a root link', async () => {
    const user = app('/files/missing/'); await login(user);
    await screen.findByRole('heading', { name: 'Папка не найдена' });
    expect(screen.queryByRole('heading', { name: 'Папка пуста' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Перейти в корень' }).getAttribute('href')).toBe('/files/');
  });
  it('keeps a conflicting folder name and the dialog open, then creates a new folder without F5', async () => {
    const user = app(); await login(user);
    await screen.findByText('Прочитай меня.txt');
    await user.click(screen.getByRole('button', { name: 'Новая папка' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Имя папки'), 'Документы');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await within(dialog).findByRole('alert');
    expect((within(dialog).getByLabelText('Имя папки') as HTMLInputElement).value).toBe('Документы');
    await user.clear(within(dialog).getByLabelText('Имя папки'));
    await user.type(within(dialog).getByLabelText('Имя папки'), 'Новая папка');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await screen.findByRole('link', { name: 'Новая папка' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('does not lose the password after incorrect credentials', async () => {
    const user = app('/sign-in');
    await screen.findByLabelText('Пароль');
    await user.type(screen.getByLabelText('Имя пользователя'), 'demo_user');
    await user.type(screen.getByLabelText('Пароль'), 'wrong_password');
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Пароль') as HTMLInputElement).value).toBe('wrong_password');
  });
  it('requires confirmation before deleting and updates the listing', async () => {
    const user = app(); await login(user);
    const file = await screen.findByText('Прочитай меня.txt');
    const row = file.closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Удалить' }));
    expect(screen.getByText('Прочитай меня.txt')).toBeTruthy();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(screen.queryByText('Прочитай меня.txt')).toBeNull());
  });
  it('renders a same-named file and directory as distinct resources', async () => {
    server.use(http.get('*/api/directory', () => HttpResponse.json([
      { path: '', name: 'same', type: 'DIRECTORY' }, { path: '', name: 'same', type: 'FILE', size: 4 },
    ])));
    const user = app(); await login(user);
    await screen.findByRole('link', { name: 'same' });
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText('Файл')).toBeTruthy();
    expect(screen.getByText('Папка')).toBeTruthy();
  });
  it.each(['https://evil.example', '//evil.example', '/sign-in', '/files/\\evil'])('rejects unsafe return URL %s', value => {
    expect(safeReturnTo(value)).toBe('/files/');
  });
});

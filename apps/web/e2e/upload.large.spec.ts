import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const filename = 'browser-1gib.bin';
const bytes = 1024 ** 3;

test('shows upload progress for 1 GiB through nginx', async ({ page, context }, info) => {
  test.setTimeout(180_000);
  const fixture = info.outputPath(filename);
  await mkdir(dirname(fixture), { recursive: true });
  const file = await open(fixture, 'wx');
  let signedIn = false;
  try {
    try { await file.truncate(bytes); } finally { await file.close(); }
    const landing = await page.goto('/sign-up');
    expect(landing?.headers().server).toMatch(/^nginx(?:\/|$)/);
    await page.getByLabel('Имя пользователя').fill(`large_${randomBytes(6).toString('hex')}`);
    await page.getByLabel('Пароль', { exact: true }).fill(randomBytes(24).toString('hex'));
    await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
    await expect(page.getByRole('heading', { name: 'Папка пуста' })).toBeVisible();
    signedIn = true;

    // Keep intermediate progress visible even on a fast local connection.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 64 * 1024 ** 2,
    });
    const upload = page.waitForResponse(response => new URL(response.url()).pathname === '/api/resource' &&
      response.request().method() === 'POST', { timeout: 120_000 });
    void upload.catch(() => {});
    await page.getByLabel('Загрузить файлы', { exact: true }).setInputFiles(fixture);

    let observed = 0;
    await expect.poll(async () => {
      observed = Number(await page.locator('progress').getAttribute('value', { timeout: 500 }).catch(() => null));
      return observed;
    }, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(observed).toBeLessThan(100);
    console.info(`Observed browser upload progress: ${observed}%`);
    await page.screenshot({ path: info.outputPath('upload-progress.png') });

    const response = await upload;
    expect(response.status()).toBe(201);
    expect(await response.json()).toEqual([{ path: '', name: filename, size: bytes, type: 'FILE' }]);
    await expect(page.getByText('Загружено файлов: 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: filename }).getByText('1 ГиБ', { exact: true })).toBeVisible();
  } finally {
    if (signedIn) {
      try {
        const result = await page.request.delete(`/api/resource?${new URLSearchParams({ path: filename })}`);
        if (![204, 404].includes(result.status())) console.warn(`Test file cleanup: HTTP ${result.status()}`);
        await page.request.post('/api/auth/sign-out');
      } finally { await unlink(fixture); }
    } else await unlink(fixture);
  }
});

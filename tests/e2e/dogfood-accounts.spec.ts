import { expect, test } from '@playwright/test';
import type { AccountProject, AuthSession } from '../../shared/accounts';

test('guest editing and project creation remain available alongside both optional login methods', async ({ page }) => {
  let indexRequests = 0;
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null, providers: { google: true, github: true } } }));
  await page.route('**/api/projects**', route => { indexRequests++; return route.fulfill({ status: 401, json: { error: 'ログインしてください。' } }); });
  const room = crypto.randomUUID();
  await page.goto(`/?room=${room}`);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  for (const provider of ['Google', 'GitHub']) {
    const link = page.getByRole('link', { name: `${provider} でログイン` });
    await expect(link).toBeVisible();
    const url = new URL((await link.getAttribute('href'))!, page.url());
    expect(url.pathname).toBe(`/api/auth/login/${provider.toLowerCase()}`);
    expect(url.searchParams.get('returnTo')).toBe(`/?room=${room}&projects=1`);
  }
  await expect(page.getByRole('region', { name: '自分のプロジェクト', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'New project', exact: false }).click();
  await expect(page).not.toHaveURL(new RegExp(room));
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  expect(indexRequests).toBe(0);
});

test('signed-in project list remembers rooms, updates titles, removes only bookmarks, and clears on logout', async ({ page }) => {
  const room = crypto.randomUUID();
  let session: AuthSession = { user: { id: 'google:example', name: 'Studio friend', provider: 'google' }, providers: { google: true, github: true } };
  const saved = new Map<string, AccountProject>([['another-private-room', { roomId: 'another-private-room', name: 'Earlier work', updatedAt: Date.now() - 86400000 }]]);
  let puts = 0;
  await page.route('**/api/auth/session', route => route.fulfill({ json: session }));
  await page.route('**/api/auth/logout', route => { session = { ...session, user: null }; return route.fulfill({ status: 204 }); });
  await page.route('**/api/projects**', async route => {
    if (!session.user) { await route.fulfill({ status: 401, json: { error: 'ログインしてください。' } }); return; }
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') { await route.fulfill({ json: { projects: [...saved.values()] } }); return; }
    expect(request.headers()['x-poietra-account']).toBe('google:example');
    const id = path.split('/').at(-1)!;
    if (request.method() === 'PUT') {
      puts++;
      const project = { roomId: id, name: request.postDataJSON().name, updatedAt: Date.now() };
      saved.set(id, project); await route.fulfill({ json: { project } });
    } else { saved.delete(id); await route.fulfill({ status: 204 }); }
  });
  await page.goto(`/?room=${room}&projects=1`);
  await expect(page.getByRole('dialog', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByText('Studio friend', { exact: true })).toBeVisible();
  await expect.poll(() => saved.get(room)?.name).toBe('A little motion');
  await expect(page.getByRole('link', { name: /Earlier work/ })).toBeVisible();
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('A new title');
  await expect.poll(() => saved.get(room)?.name).toBe('A new title');
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  await page.getByRole('button', { name: 'A new title を自分の一覧から外す', exact: true }).click();
  await expect.poll(() => saved.has(room)).toBe(false);
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Still shared');
  await page.waitForTimeout(900);
  expect(saved.has(room)).toBe(false);
  await page.getByRole('button', { name: 'プロジェクトを開く', exact: true }).click();
  await page.getByRole('button', { name: 'このプロジェクトを一覧に保存', exact: true }).click();
  await expect.poll(() => saved.get(room)?.name).toBe('Still shared');
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  await expect(page.getByRole('region', { name: '自分のプロジェクト', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Google でログイン' })).toBeVisible();
  const before = puts;
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Edited as guest');
  await page.waitForTimeout(800);
  expect(puts).toBe(before);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(room));
});

test('a cancelled login returns to the same guest project with an actionable message', async ({ page }) => {
  const room = crypto.randomUUID();
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null, providers: { google: true, github: true } } }));
  await page.goto(`/?room=${room}&projects=1&auth_error=denied`);
  await expect(page.getByRole('dialog', { name: 'Your projects' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('ログインをキャンセルしました');
  await expect(page).toHaveURL(new RegExp(`room=${room}$`));
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Guest continues');
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Guest continues');
});

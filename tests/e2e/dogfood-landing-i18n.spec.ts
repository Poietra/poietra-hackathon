import { expect, test, type Page } from '@playwright/test';

test.use({ locale: 'en-US' });

const japanese = /[\u3040-\u30ff\u3400-\u9fff]/;
const newProject = (page: Page) => page.getByRole('button', { name: 'New project', exact: true });
const example = (page: Page) => page.getByRole('button', { name: 'Edit the example', exact: true });
const room = (page: Page) => new URL(page.url()).searchParams.get('room');

async function expectLocale(page: Page, locale: 'en' | 'ja') {
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.getByRole('button', { name: /^(English|日本語)$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: locale === 'en' ? 'New project' : '新しいプロジェクト', exact: true })).toBeVisible();
  const description = await page.locator('meta[name="description"]').getAttribute('content');
  expect(description?.trim()).toBeTruthy();
  if (locale === 'ja') expect(description).toMatch(japanese);
  else expect(description).not.toMatch(japanese);
}

for (const [label, languages, expected] of [
  ['Japanese regional preference', ['ja-JP'], 'ja'],
  ['American English preference', ['en-US'], 'en'],
  ['British English preference', ['en-GB'], 'en'],
  ['unsupported languages', ['fr-FR', 'de-DE'], 'en'],
  ['missing language preferences', [], 'en'],
  ['first supported language after an unsupported one', ['fr-FR', 'ja-JP', 'en-US'], 'ja'],
] as const) {
  test(`${label} resolves the homepage language`, async ({ page }) => {
    await page.addInitScript(languages => {
      Object.defineProperty(navigator, 'languages', { configurable: true, value: languages });
      if (!languages.length) Object.defineProperty(navigator, 'language', { configurable: true, value: '' });
    }, languages);
    await page.goto('/');
    await expectLocale(page, expected);
    expect(room(page)).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBeNull();
  });
}

test('saved preference wins over the browser, URL wins over saved preference, and invalid values are ignored', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('locale-test-seeded')) {
      localStorage.setItem('poietra-locale', 'ja');
      sessionStorage.setItem('locale-test-seeded', 'true');
    }
  });
  await page.goto('/'); await expectLocale(page, 'ja');
  await page.goto('/?lang=en'); await expectLocale(page, 'en');
  expect(await page.evaluate(() => localStorage.getItem('poietra-locale'))).toBe('ja');
  await page.goto('/?lang=invalid'); await expectLocale(page, 'ja');
  await page.evaluate(() => localStorage.setItem('poietra-locale', 'invalid'));
  await page.goto('/?lang=invalid'); await expectLocale(page, 'en');
});

test('URL language preference works when local storage is unavailable', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new DOMException('Storage blocked for this test', 'SecurityError'); },
  }));
  await page.goto('/?lang=ja&utm_source=storage-test#motion'); await expectLocale(page, 'ja');
  expect(new URL(page.url()).searchParams.get('lang')).toBe('ja');
  expect(new URL(page.url()).searchParams.get('utm_source')).toBe('storage-test');
  expect(new URL(page.url()).hash).toBe('#motion');
  await page.reload(); await expectLocale(page, 'ja');
  expect(errors).toEqual([]);
});

test('English actions fit a narrow screen and remain keyboard accessible', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/'); await expectLocale(page, 'en');
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  for (const control of [newProject(page), example(page), page.getByRole('button', { name: 'Start creating', exact: true })]) {
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
    await control.focus(); await expect(control).toBeFocused();
  }
  await page.screenshot({ path: info.outputPath('home-english-320.png'), fullPage: true });
});

test('English new-project and example actions open distinct working editors', async ({ page }) => {
  await page.goto('/'); await expectLocale(page, 'en'); await newProject(page).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.studio')).toHaveCSS('display', 'grid');
  const blankRoom = room(page); expect(blankRoom).toMatch(/^[a-zA-Z0-9_-]{16,80}$/);
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project');
  await expect(page.getByRole('button', { name: 'Circle', exact: true })).toHaveCount(0);
  // The editor has not been translated in this task and keeps its own language.
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.goto('/'); await expectLocale(page, 'en');
  const previous = page.getByRole('link', { name: 'Open previous project', exact: true });
  await expect(previous).toBeVisible(); expect(new URL((await previous.getAttribute('href'))!, page.url()).searchParams.get('room')).toBe(blankRoom);
  await example(page).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
  expect(room(page)).toMatch(/^[a-zA-Z0-9_-]{16,80}$/); expect(room(page)).not.toBe(blankRoom);
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('A little motion');
  await expect(page.getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
});

test('English busy, cancellation and connection errors keep internal Japanese errors out of the homepage', async ({ page }) => {
  test.setTimeout(45000);
  let attempts = 0;
  await page.routeWebSocket('**/sync/**', socket => { attempts++; socket.close(); });
  await page.goto('/'); await newProject(page).click();
  // The demo's <output> has an implicit status role as well.
  const status = page.locator('.landing-launch-status').getByRole('status');
  await expect(status).toBeVisible(); expect(await status.innerText()).not.toMatch(japanese);
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeVisible(); await cancel.click();
  await expect(newProject(page)).toBeEnabled(); expect(room(page)).toBeNull();
  await example(page).click(); await expect.poll(() => attempts).toBeGreaterThan(0);
  await expect(status).toBeVisible(); expect(await status.innerText()).not.toMatch(japanese);
  const error = page.getByRole('alert'); await expect(error).toBeVisible({ timeout: 20000 });
  expect((await error.innerText()).trim()).not.toHaveLength(0); expect(await error.innerText()).not.toMatch(japanese);
  await expect(error).toContainText('Could not open the project. Check your connection and try again.');
  await expect(newProject(page)).toBeEnabled(); await expect(example(page)).toBeEnabled();
  expect(room(page)).toBeNull(); expect(new URL(page.url()).pathname).toBe('/');
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBeNull();
});

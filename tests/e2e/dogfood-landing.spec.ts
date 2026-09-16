import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({ locale: 'ja-JP' });

const ROOM = /^[a-zA-Z0-9_-]{16,80}$/;
const newProject = (page: Page) => page.getByRole('button', { name: '新しいプロジェクト', exact: true });
const sampleProject = (page: Page) => page.getByRole('button', { name: 'サンプルを編集', exact: true });
const resumeProject = (page: Page) => page.getByRole('link', { name: '前のプロジェクトを開く', exact: true });
async function live(page: Page) {
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15000 });
  // A successful editor import must also load its stylesheet. Vite can regress
  // CSS preloading independently from the JavaScript and collaboration state.
  await expect(page.locator('.studio')).toHaveCSS('display', 'grid');
  const styles = await page.evaluate(() => [...document.styleSheets].map(sheet => sheet.href).filter(Boolean));
  expect(styles.filter(href => /\/assets\/home-[^/]+\.css$|\/src\/ui\/LandingPage\.css$/.test(href!))).toEqual([]);
}
const currentRoom = (page: Page) => new URL(page.url()).searchParams.get('room');

async function priorRoom(page: Page, room: string) {
  await page.addInitScript(room => {
    // Seed once per test tab, so later navigations exercise the application's persistence.
    if (!sessionStorage.getItem('landing-test-seeded')) {
      localStorage.setItem('poietra-last-room', room);
      sessionStorage.setItem('landing-test-seeded', 'true');
    }
  }, room);
}

test('home is an accessible entry without creating a room or loading the editor engine', async ({ page }, info) => {
  const requests: string[] = [], sockets: string[] = [];
  page.on('request', request => requests.push(new URL(request.url()).pathname));
  page.on('websocket', socket => { if (new URL(socket.url()).pathname.startsWith('/sync/')) sockets.push(socket.url()); });
  await page.addInitScript(() => {
    const storage = Storage.prototype.setItem;
    (window as unknown as { landingRoomWrites: string[] }).landingRoomWrites = [];
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === 'poietra-last-room') (window as unknown as { landingRoomWrites: string[] }).landingRoomWrites.push(value);
      return storage.call(this, key, value);
    };
  });
  await page.goto('/');
  await expect(newProject(page)).toBeVisible(); await expect(sampleProject(page)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Poietra ホーム', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(resumeProject(page)).toHaveCount(0);
  const study = page.getByRole('slider', { name: '動きのデモの再生位置', exact: true });
  await study.focus(); await study.press('Home'); await expect(study).toHaveValue('0');
  await expect(page.locator('[data-demo-object]')).toHaveAttribute('opacity', '0');
  const startX = Number(await page.locator('[data-demo-object]').getAttribute('cx'));
  await study.press('End'); await expect(study).toHaveValue('2000');
  await expect(page.locator('[data-demo-object]')).toHaveAttribute('opacity', '1');
  expect(Number(await page.locator('[data-demo-object]').getAttribute('cx'))).toBeGreaterThan(startX);
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(new URL(page.url()).pathname).toBe('/'); expect(currentRoom(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { landingRoomWrites: string[] }).landingRoomWrites)).toEqual([]);
  expect(sockets).toEqual([]);
  expect(requests.filter(path => /\.wasm$|\/src\/engine\/|\/src\/editor\/bootstrap|mathjax|mediabunny|\/assets\/(?:bootstrap|editor|studio|svg|media|kernel|painter|renderer|export)[^/]*\.js$/i.test(path))).toEqual([]);
  const resources = await page.evaluate(() => (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map(entry => ({ path: new URL(entry.name).pathname, transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize })));
  await writeFile(info.outputPath('home-loading.json'), JSON.stringify({ javascriptBytes: resources.filter(entry => /\.[cm]?js$/.test(entry.path)).reduce((total, entry) => total + entry.decodedBytes, 0), resources }, null, 2));
  // The primary action remains reachable without a pointing device.
  await newProject(page).focus(); await expect(newProject(page)).toBeFocused();
  await page.screenshot({ path: info.outputPath('home-desktop.png'), fullPage: true });
});

for (const width of [320, 390]) test(`home fits a ${width}px viewport with usable actions`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto('/');
  await expect(newProject(page)).toBeVisible(); await expect(sampleProject(page)).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(1);
  for (const control of [newProject(page), sampleProject(page)]) {
    const bounds = await control.boundingBox(); expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(40);
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1);
  }
  await page.screenshot({ path: info.outputPath(`home-${width}.png`), fullPage: true });
});

test('new project creates a fresh blank shared room without replacing previous work', async ({ page, browser }) => {
  const existing = crypto.randomUUID();
  await page.goto(`/?room=${existing}`); await live(page);
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Work before visiting home');
  await page.getByRole('textbox', { name: 'Project name', exact: true }).press('Tab');
  await page.goto('/');
  await expect(resumeProject(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBe(existing);
  await newProject(page).click(); await live(page);
  const created = currentRoom(page)!;
  expect(created).toMatch(ROOM); expect(created).not.toBe(existing);
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project');
  await expect(page.getByRole('button', { name: 'Composition 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Circle', exact: true })).toHaveCount(0);
  const other = await browser.newContext();
  try {
    const peer = await other.newPage(); await peer.goto(page.url()); await live(peer);
    await expect(peer.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project');
    await peer.goto(`/?room=${existing}`); await live(peer);
    await expect(peer.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Work before visiting home');
    await expect(peer.getByRole('button', { name: 'Circle', exact: true })).toBeVisible();
  } finally { await other.close(); }
});

test('each sample is a fresh project and its link supports another guest browser', async ({ page, browser }) => {
  await page.goto('/'); await sampleProject(page).click(); await live(page);
  const first = currentRoom(page)!; expect(first).toMatch(ROOM);
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('My edited example');
  await page.getByRole('textbox', { name: 'Project name', exact: true }).press('Tab');
  await page.goto('/'); await sampleProject(page).click(); await live(page);
  expect(currentRoom(page)).toMatch(ROOM); expect(currentRoom(page)).not.toBe(first);
  await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('A little motion');
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const other = await browser.newContext();
  try {
    const peer = await other.newPage(); await peer.goto(page.url()); await live(peer);
    await peer.getByRole('button', { name: 'Circle', exact: true }).click();
    const x = peer.getByRole('spinbutton', { name: 'Position X', exact: true }); await x.fill('333'); await x.press('Tab');
    await expect(page.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue('333');
    await peer.goto(`/?room=${first}`); await live(peer);
    await expect(peer.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('My edited example');
  } finally { await other.close(); }
});

test('home preserves the last room until a resume link or /studio explicitly opens it', async ({ page }) => {
  const room = crypto.randomUUID(); await priorRoom(page, room);
  const sockets: string[] = []; page.on('websocket', socket => { if (new URL(socket.url()).pathname.startsWith('/sync/')) sockets.push(socket.url()); });
  await page.goto('/'); await expect(resumeProject(page)).toBeVisible();
  expect(new URL((await resumeProject(page).getAttribute('href'))!, page.url()).searchParams.get('room')).toBe(room);
  expect(currentRoom(page)).toBeNull(); expect(sockets).toEqual([]);
  await resumeProject(page).click(); await live(page); expect(currentRoom(page)).toBe(room);
  await page.goto('/'); await expect(newProject(page)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBe(room);
  await page.goto('/studio'); await live(page); expect(currentRoom(page)).toBe(room);
});

test('invalid saved room does not create a broken resume link and /studio recovers with a valid room', async ({ page }) => {
  await priorRoom(page, '../../invalid-room');
  await page.goto('/'); await expect(newProject(page)).toBeVisible(); await expect(resumeProject(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBe('../../invalid-room');
  await page.goto('/studio'); await live(page); expect(currentRoom(page)).toMatch(ROOM);
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBe(currentRoom(page));
});

for (const query of ['projects=1', 'auth_error=denied']) test(`existing OAuth entry /?${query} opens the prior editor`, async ({ page }) => {
  const room = crypto.randomUUID(); await priorRoom(page, room);
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: null, providers: { google: false, github: false } } }));
  await page.goto('/?' + query);
  await expect(page.getByRole('dialog', { name: 'Your projects' })).toBeVisible({ timeout: 15000 });
  expect(currentRoom(page)).toBe(room);
  if (query.startsWith('auth_error')) await expect(page.getByRole('alert')).toContainText('ログインをキャンセルしました');
  await page.getByRole('button', { name: '閉じる', exact: true }).click(); await live(page);
  await expect(newProject(page)).toHaveCount(0);
});

test('cancelled and failed creation stay on home and preserve the previous room', async ({ page }) => {
  test.setTimeout(45000);
  const room = crypto.randomUUID(); await priorRoom(page, room);
  let attempts = 0;
  await page.routeWebSocket('**/sync/**', socket => { attempts++; socket.close(); });
  await page.goto('/'); await newProject(page).click();
  await expect(page.getByRole('button', { name: 'キャンセル', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(newProject(page)).toBeEnabled();
  expect(currentRoom(page)).toBeNull(); expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBe(room);
  await sampleProject(page).click();
  await expect.poll(() => attempts).toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 20000 });
  await expect(newProject(page)).toBeEnabled(); await expect(sampleProject(page)).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe('/'); expect(currentRoom(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('poietra-last-room'))).toBe(room);
  await expect(resumeProject(page)).toBeVisible();
});

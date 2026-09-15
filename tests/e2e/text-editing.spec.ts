import { expect, test, type Page } from '@playwright/test';

async function world(page: Page, x: number, y: number, stage = 'main') {
  const box = await page.getByTestId(`stage-${stage}`).boundingBox();
  return { x: box!.x + x / 1280 * box!.width, y: box!.y + y / 720 * box!.height };
}
async function field(page: Page, name: string, value: number) {
  const input = page.getByRole('spinbutton', { name, exact: true });
  await input.fill(String(value)); await input.press('Tab');
}
async function blankPoint(page: Page, id: string, stage = 'main') {
  const selection = page.locator(`[data-testid="stage-${stage}"] [data-selection-id="${id}"]`);
  await expect(selection).toBeVisible();
  const point = await selection.evaluate(element => {
    const rect = element.querySelector('rect')!;
    const x = Number(rect.getAttribute('x')), y = Number(rect.getAttribute('y'));
    const width = Number(rect.getAttribute('width')), height = Number(rect.getAttribute('height'));
    const matrix = (element as SVGGraphicsElement).getScreenCTM()!;
    for (const fx of [.5, .65, .35, .8, .2]) for (const fy of [.5, .4, .6, .25, .75]) {
      const at = new DOMPoint(x + width * fx, y + height * fy).matrixTransform(matrix);
      const hit = document.elementFromPoint(at.x, at.y);
      if (hit?.closest('[data-testid]')?.getAttribute('data-testid')?.startsWith('stage-') && !hit.closest('[data-object-id], [data-transform-handle], [data-path-handle]')) return { x: at.x, y: at.y };
    }
    return null;
  });
  expect(point, 'use genuinely empty space inside the rotated text bounds').not.toBeNull();
  return point!;
}

for (const example of [
  { tool: 'テキスト (T)', label: 'Text content', content: '日本語　　　編集\n次の行', revised: '日本語　　　再編集\n次の行' },
  { tool: '数式 (E)', label: 'LaTeX expression', content: String.raw`x \qquad\qquad\qquad y`, revised: String.raw`x \qquad\qquad\qquad z` },
]) test(`${example.label}: create, edit, drag rotated whitespace, reopen, undo and synchronize the same object`, async ({ page, browser }) => {
  const room = crypto.randomUUID();
  await page.goto(`/?room=${room}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  const peerContext = await browser.newContext(); const peer = await peerContext.newPage();
  try {
    await peer.goto(`/?room=${room}`); await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: example.tool, exact: true }).click();
    const at = await world(page, 650, 230); await page.mouse.click(at.x, at.y);
    const input = page.getByRole('textbox', { name: example.label, exact: true });
    await expect(input).toBeFocused();
    const id = await page.locator('.layer-row.selected').getAttribute('data-layer-id'); expect(id).toBeTruthy();
    await input.fill(example.content); await input.press('Tab');
    await expect(page.locator(`[data-testid="stage-main"] .scene-svg [data-object-id="${id}"]`)).toBeVisible();
    await field(page, 'Rotation', 35);
    await page.getByRole('combobox', { name: 'キャンバスのズーム', exact: true }).selectOption('0.75');
    await peer.locator(`[data-layer-id="${id}"] .layer-select`).click();
    await expect(peer.getByRole('textbox', { name: example.label, exact: true })).toHaveValue(example.content);
    await expect(peer.getByRole('spinbutton', { name: 'Rotation', exact: true })).toHaveValue('35');

    // Leave focus in the text field, then grab space between actual glyphs.
    await input.focus();
    const empty = await blankPoint(page, id!);
    const beforeX = Number(await page.getByRole('spinbutton', { name: 'Position X', exact: true }).inputValue());
    await page.mouse.move(empty.x, empty.y); await page.mouse.down();
    await page.mouse.move(empty.x + 30, empty.y + 15, { steps: 5 }); await page.mouse.up();
    await expect(page.getByTestId('stage-main')).toBeFocused();
    const position = page.getByRole('spinbutton', { name: 'Position X', exact: true });
    await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(beforeX + 20);
    const movedX = await position.inputValue();
    await expect(peer.getByRole('spinbutton', { name: 'Position X', exact: true })).toHaveValue(movedX);
    await expect(page.locator('.layer-row')).toHaveCount(4);

    const nextEmpty = await blankPoint(page, id!);
    await page.mouse.dblclick(nextEmpty.x, nextEmpty.y);
    await expect(input).toBeFocused();
    await input.fill(example.revised); await input.press('Tab');
    await expect(peer.getByRole('textbox', { name: example.label, exact: true })).toHaveValue(example.revised);
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(input).toHaveValue(example.content);
    await expect(peer.getByRole('textbox', { name: example.label, exact: true })).toHaveValue(example.content);
    await expect(position).toHaveValue(movedX);
    await expect(page.locator('.layer-row.selected')).toHaveAttribute('data-layer-id', id!);

    // The canvas click returns arrow keys to object editing after text input.
    await input.focus(); const keyboardPoint = await blankPoint(page, id!);
    await page.mouse.click(keyboardPoint.x, keyboardPoint.y); await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Number(await position.inputValue())).toBeCloseTo(Number(movedX) + 1, 1);
    await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
    await expect(position).toHaveValue(movedX);
  } finally { await peerContext.close(); }
});

test('double click edits the visible transition destination, while an interpolated preview stays read only', async ({ page }) => {
  await page.goto(`/?room=${crypto.randomUUID()}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await page.getByRole('button', { name: 'Equation', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Transition preview position', exact: true });
  await slider.fill('700');
  const equation = page.locator('[data-testid="stage-to"] [data-object-id="equation"]');
  await expect(equation).toBeVisible();
  const previewPoint = await world(page, 855, 440, 'to');
  await page.mouse.dblclick(previewPoint.x, previewPoint.y);
  await expect(slider).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'LaTeX expression', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Composition 1', exact: true }).click();
  await page.getByRole('button', { name: 'Transition 800 ms', exact: true }).click();
  await page.getByRole('button', { name: 'Equation', exact: true }).click();
  const empty = await blankPoint(page, 'equation', 'to');
  await page.mouse.dblclick(empty.x, empty.y);
  await expect(page.getByRole('textbox', { name: 'LaTeX expression', exact: true })).toBeFocused();
  await expect(page.getByTestId('stage-main')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Composition 2', exact: true })).toHaveClass(/selected/);
});


test('grabbing the canvas commits an unfinished Inspector value before starting the drag', async ({ page }) => {
  await page.goto(`/?room=${crypto.randomUUID()}`); await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  const input = page.getByRole('spinbutton', { name: 'Position X', exact: true });
  await input.fill('500'); // Deliberately leave the field focused, with its value uncommitted.
  const at = await world(page, 245, 520), stage = await page.getByTestId('stage-main').boundingBox();
  await page.mouse.move(at.x, at.y); await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y, { steps: 5 }); await page.mouse.up();
  const expected = 500 + 30 / stage!.width * 1280;
  await expect.poll(async () => Number(await input.inputValue())).toBeCloseTo(expected, 0);
  await page.getByRole('button', { name: '元に戻す (⌘Z)', exact: true }).click();
  await expect(input).toHaveValue('500');
});

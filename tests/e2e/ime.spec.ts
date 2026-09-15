import { expect, test } from '@playwright/test';

interface ImeEvent {
  type: string;
  data?: string | null;
  inputType?: string;
  key?: string;
  isComposing?: boolean;
  isTrusted: boolean;
}

test('Chromium composition commits Japanese text, preserves Enter, then returns canvas Delete and Undo to object editing', async ({ browser }) => {
  // CDP drives Chromium's composition machinery; this is not a host OS IME test.
  const first = await browser.newContext(), second = await browser.newContext();
  const page = await first.newPage(), peer = await second.newPage();
  const room = crypto.randomUUID(), cdp = await first.newCDPSession(page);
  try {
    await Promise.all([page.goto(`/?room=${room}`), peer.goto(`/?room=${room}`)]);
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(peer.getByText('Live', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'テキスト (T)', exact: true }).click();
    const stage = page.getByTestId('stage-main'), rect = await stage.boundingBox();
    await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 3);
    const input = page.getByRole('textbox', { name: 'Text content', exact: true });
    await expect(input).toBeFocused();
    const id = await page.locator('.layer-row.selected').getAttribute('data-layer-id');
    expect(id).toBeTruthy();
    await peer.locator(`[data-layer-id="${id}"] .layer-select`).click();
    const peerInput = peer.getByRole('textbox', { name: 'Text content', exact: true });
    await page.evaluate(() => {
      const events: ImeEvent[] = [];
      (window as unknown as { imeTestEvents: ImeEvent[] }).imeTestEvents = events;
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'keydown']) {
        document.addEventListener(type, event => {
          const detail = event as InputEvent & KeyboardEvent;
          events.push({ type, data: detail.data, inputType: detail.inputType, key: detail.key, isComposing: detail.isComposing, isTrusted: event.isTrusted });
        });
      }
    });
    await input.press('Control+a');
    await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
    await expect(input).toHaveValue('にほんご');
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Unidentified', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: 'Unidentified', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
    await expect(input).toHaveValue('日本語');
    await expect(page.locator('.layer-row')).toHaveCount(4);
    await expect(page.locator('.tool-instruction')).toHaveCount(0);
    await expect(page.locator('.time-code strong')).toHaveText('0');
    await cdp.send('Input.insertText', { text: '日本語' });
    await input.press('Enter');
    await expect(input).toHaveValue('日本語\n');
    await cdp.send('Input.imeSetComposition', { text: 'つぎのぎょう', selectionStart: 6, selectionEnd: 6 });
    await cdp.send('Input.imeSetComposition', { text: '次の行', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '次の行' });
    await expect(input).toHaveValue('日本語\n次の行');
    await expect(peerInput).toHaveValue('日本語\n次の行');
    const events = await page.evaluate(() => (window as unknown as { imeTestEvents: ImeEvent[] }).imeTestEvents);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'compositionstart', isTrusted: true }),
      expect.objectContaining({ type: 'compositionupdate', data: 'にほんご', isTrusted: true }),
      expect.objectContaining({ type: 'input', data: '日本語', inputType: 'insertCompositionText', isComposing: true, isTrusted: true }),
      expect.objectContaining({ type: 'keydown', key: 'Process', isComposing: true, isTrusted: true }),
      // Chromium CDP may mark compositionend untrusted; assert the actual end,
      // rather than claiming that automation reproduces OS candidate UI behavior.
      expect.objectContaining({ type: 'compositionend', data: '日本語' }),
      expect.objectContaining({ type: 'input', inputType: 'insertLineBreak', isComposing: false, isTrusted: true }),
    ]));
    const text = page.locator(`[data-testid="stage-main"] .scene-svg [data-object-id="${id}"]`);
    await text.click(); await expect(stage).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(text).toHaveCount(0);
    await expect(peer.locator(`[data-testid="stage-main"] [data-object-id="${id}"]`)).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(text).toBeVisible();
    await expect(peer.locator(`[data-testid="stage-main"] [data-object-id="${id}"]`)).toBeVisible();
    await peer.locator(`[data-layer-id="${id}"] .layer-select`).click();
    await expect(peerInput).toHaveValue('日本語\n次の行');
    await expect(page.locator('.layer-row')).toHaveCount(4);
    await expect(page.locator('.time-code strong')).toHaveText('0');
  } finally { await cdp.detach(); await first.close(); await second.close(); }
});

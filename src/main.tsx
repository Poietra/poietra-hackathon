import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/noto-sans-jp/400.css';
import { isEditorLocation } from './navigation';
import { applyPageLanguage, getLocale, pageCopy } from './locale';
import './entry.css';

const root = createRoot(document.getElementById('root')!);
const editor = isEditorLocation(new URL(location.href));
document.body.dataset.page = editor ? 'editor' : 'home';
applyPageLanguage(editor ? 'ja' : getLocale());
root.render(<div className="entry-message" role="status"><img src="/poietra.svg" alt="Poietra"/>{editor && <span>Opening your studio</span>}</div>);
async function openPage() {
  // Keep the imports in separate awaited branches so each entry retains its own CSS preload dependencies.
  if (editor) {
    const module = await import('./editor/bootstrap');
    await module.openEditor(root);
  } else {
    const module = await import('./home');
    module.openHome(root);
  }
}
openPage().catch(() => {
  const copy = pageCopy[editor ? 'ja' : getLocale()];
  root.render(<div className="entry-message"><img src="/poietra.svg" alt="Poietra"/><h1>{copy.loadError}</h1><p>{copy.retryHint}</p><button onClick={() => location.reload()}>{copy.retry}</button></div>);
});

import { createRoot } from 'react-dom/client';
import { isEditorLocation } from './navigation';
import { applyPageLanguage, getLocale, pageCopy } from './locale';
import './entry.css';

const container = document.getElementById('root')!;
const editor = isEditorLocation(new URL(location.href));
document.body.dataset.page = editor ? 'editor' : 'home';
// Keep the prerendered homepage visible while its controls load.
const root = editor ? createRoot(container) : null;
if (root) {
  applyPageLanguage('ja');
  root.render(<div className="entry-message" role="status"><img src="/poietra.svg" alt="Poietra"/><span>Opening your studio</span></div>);
}
async function openPage() {
  // Keep the imports in separate awaited branches so each entry retains its own CSS preload dependencies.
  if (editor) {
    const module = await import('./editor/bootstrap');
    await module.openEditor(root!);
  } else {
    const module = await import('./home');
    module.openHome(container);
  }
}
openPage().catch(() => {
  const copy = pageCopy[editor ? 'ja' : getLocale()];
  (root ?? createRoot(container)).render(<div className="entry-message"><img src="/poietra.svg" alt="Poietra"/><h1>{copy.loadError}</h1><p>{copy.retryHint}</p><button onClick={() => location.reload()}>{copy.retry}</button></div>);
});

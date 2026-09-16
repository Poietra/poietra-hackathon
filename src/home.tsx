import { StrictMode, useEffect, useRef, useState } from 'react';
import type { Root } from 'react-dom/client';
import { Boundary } from './ui/Boundary';
import { LandingPage } from './ui/LandingPage';
import { lastRoom, roomLink } from './navigation';
import { applyPageLanguage, getLocale, pageCopy } from './locale';

function Home() {
  const [locale, setLanguage] = useState(getLocale);
  const [busy, setBusy] = useState<'blank' | 'example' | null>(null);
  const [failed, setFailed] = useState(false);
  const [resumeUrl] = useState(() => { const room = lastRoom(); return room ? roomLink(room) : null; });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { applyPageLanguage(locale); }, [locale]);
  useEffect(() => {
    const syncLanguage = () => setLanguage(getLocale());
    window.addEventListener('languagechange', syncLanguage);
    return () => window.removeEventListener('languagechange', syncLanguage);
  }, []);

  async function start(template: 'blank' | 'example') {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setBusy(template); setFailed(false);
    try {
      // No editor, media codec or collaboration code is needed until the visitor starts a project.
      const [{ createProjectRoom }, { makeBlankScene, makeDemoProject }] = await Promise.all([import('./editor/projects'), import('../shared/demo')]);
      request.signal.throwIfAborted();
      const id = `scene_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const project = template === 'example' ? makeDemoProject() : { version: 1 as const, name: 'Untitled project', sceneOrder: [id], scenes: { [id]: makeBlankScene(id, 'Scene 1') } };
      const url = await createProjectRoom(project, request.signal);
      request.signal.throwIfAborted();
      // Keep marketing parameters and in-page section fragments out of share links.
      location.assign(roomLink(url.searchParams.get('room')!));
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(null); }
    }
  }
  function cancel() { controller.current?.abort(); controller.current = null; setBusy(null); }
  return <LandingPage locale={locale} onStart={template => void start(template)} busy={busy} error={failed ? pageCopy[locale].projectError : ''} onCancel={cancel} resumeUrl={resumeUrl}/>;
}

export function openHome(root: Root) { root.render(<StrictMode><Boundary><Home/></Boundary></StrictMode>); }

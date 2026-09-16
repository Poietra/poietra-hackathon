import { StrictMode, useEffect, useRef, useState } from 'react';
import type { Root } from 'react-dom/client';
import { Boundary } from './ui/Boundary';
import { LandingPage } from './ui/LandingPage';
import { lastRoom, roomLink } from './navigation';

function Home() {
  const [busy, setBusy] = useState<'blank' | 'example' | null>(null);
  const [error, setError] = useState('');
  const [resumeUrl] = useState(() => { const room = lastRoom(); return room ? roomLink(room) : null; });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function start(template: 'blank' | 'example') {
    if (controller.current) return;
    const request = new AbortController(); controller.current = request;
    setBusy(template); setError('');
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
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : 'プロジェクトを開けませんでした。もう一度お試しください。');
    } finally {
      if (controller.current === request) { controller.current = null; setBusy(null); }
    }
  }
  function cancel() { controller.current?.abort(); controller.current = null; setBusy(null); }
  return <LandingPage onStart={template => void start(template)} busy={busy} error={error} onCancel={cancel} resumeUrl={resumeUrl}/>;
}

export function openHome(root: Root) { root.render(<StrictMode><Boundary><Home/></Boundary></StrictMode>); }

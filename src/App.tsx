import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { ArrowRight, BookOpen, ChartNoAxesColumnIncreasing, Check, ChevronDown, Circle, Copy, Download, Film, LoaderCircle, MousePointer2, Pause, Play, Plus, Redo2, Send, Share2, Sigma, SlidersHorizontal, Sparkles, Spline, Square, Type, Undo2, X, ArrowUpRight, Minus, Keyboard, Link2 } from 'lucide-react';
import { EditorContext, type Tool } from './editor/context';
import { EditorStore } from './editor/store';
import { compositionFrame, evaluateScene, transitionFrame } from './engine/evaluate';
import type { MotionKernel } from './engine/kernel';
import type { ExporterContract, RendererContract } from './engine/render-contract';
import type { PainterContract } from './engine/painter-contract';
import { clamp, ms, sceneDuration, sceneSegments, type Selection } from '../shared/model';
import { Sidebar } from './ui/Sidebar';
import { Inspector } from './ui/Inspector';
import { Timeline } from './ui/Timeline';
import { Stage } from './ui/Stage';
import { AssistantPanel } from './ui/AssistantPanel';
import { ProjectDialog } from './ui/ProjectDialog';
import { PlaybackPanel } from './ui/PlaybackPanel';
import { ExportDialog } from './ui/ExportDialog';
import { SceneTabs } from './ui/SceneTabs';
import { ConnectionStatus } from './ui/ConnectionStatus';
import { IconButton, Modal } from './ui/components';
import { download } from './ui/utils';
import { copyObjects, parseObjects, serializeObjects, OBJECT_CLIPBOARD_MIME } from '../shared/clipboard';

export function App({ store, kernel, renderer, exporter, createFramePainter }: { store: EditorStore; kernel: MotionKernel; renderer: RendererContract; exporter: ExporterContract | null; createFramePainter?: PainterContract['createFramePainter'] }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  const [sceneId, setSceneId] = useState('scene-1');
  const [requestedSelection, setRequestedSelection] = useState<Selection>({ kind: 'composition', id: 'comp-1' });
  const [selectedIds, setSelectedIds] = useState<string[]>([]); const [tool, setTool] = useState<Tool>('select');
  const [playhead, setPlayhead] = useState(0); const [playing, setPlaying] = useState(false); const [previewScope, setPreviewScope] = useState<'scene'|'transition'>('scene');
  const [transportView, setTransportView] = useState(false);
  const [pathEditing, setPathEditing] = useState(false); const [zoom, setZoom] = useState(1);
  const [rightTab, setRightTab] = useState<'properties'|'assistant'>('properties'); const [shareOpen, setShareOpen] = useState(false); const [helpOpen, setHelpOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false); const [copied, setCopied] = useState(false); const [name, setName] = useState(store.userName);
  const [toast, setToast] = useState(''); const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renderRevision, setRenderRevision] = useState(0); const [renderError, setRenderError] = useState('');
  const renderReady = renderRevision > 0;
  const playStart = useRef({ time: 0, position: 0, end: 0 });
  const pasteInPlace = useRef(false);
  const lastPaste = useRef({ text: '', count: 0, target: '' });
  const nudge = useRef<string | null>(null);
  const project = snapshot.project;
  const scene = project?.scenes[sceneId] ?? (project ? project.scenes[project.sceneOrder[0]] : null);
  const selection = scene && ((requestedSelection.kind === 'composition' && scene.compositions[requestedSelection.id]) || (requestedSelection.kind === 'transition' && scene.transitions[requestedSelection.id])) ? requestedSelection : { kind: 'composition' as const, id: scene?.compositionOrder[0] || '' };
  const transition = scene && selection.kind === 'transition' ? scene.transitions[selection.id] : null;
  const compositionId = transition ? transition.toId : selection.id;
  const activeIds = selectedIds.filter(id => !!scene?.objects[id]);
  const total = scene ? sceneDuration(scene) : 0;
  const segments = scene ? sceneSegments(scene) : [];
  const selectedSegment = segments.find(part => part.id === selection.id);
  const playbackSegment = segments.find(part => playhead < part.start + part.duration) ?? segments.at(-1);
  const localTime = transition ? clamp(playhead - (selectedSegment?.start || 0), 0, transition.duration) : 0;

  function notify(message: string) { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(message); toastTimer.current = setTimeout(() => setToast(''), 4000); }
  function select(next: Selection) { setPlaying(false); setTransportView(false); setRequestedSelection(next); setPathEditing(false); setPlayhead(scene ? sceneSegments(store.scene(scene.id)).find(part => part.id === next.id)?.start || 0 : 0); }
  function changeScene(id: string) { setSceneId(id); setPlaying(false); setTransportView(false); setPlayhead(0); setSelectedIds([]); setPathEditing(false); const next = store.project().scenes[id]; if (next) setRequestedSelection({ kind: 'composition', id: next.compositionOrder[0] }); }
  function newScene() { try { const id = store.addScene(); changeScene(id); } catch (error) { notify(error instanceof Error ? error.message : 'Scene を追加できませんでした。'); } }
  function editMoment(compositionOnly = false) {
    if (!scene || !playbackSegment) return;
    const next = compositionOnly && playbackSegment.kind === 'transition' ? { kind: 'composition' as const, id: scene.transitions[playbackSegment.id].toId } : { kind: playbackSegment.kind, id: playbackSegment.id };
    select(next);
    if (next.kind === 'transition') setPlayhead(clamp(playhead, playbackSegment.start, playbackSegment.start + playbackSegment.duration));
  }
  function activateTool(value: Tool) { setTool(value); setPlaying(false); if (transportView) { editMoment(value !== 'select'); return; } setTransportView(false); if (transition) select({ kind: 'composition', id: transition.toId }); }
  function chooseObjects(ids: string[]) { if (transportView) editMoment(); setSelectedIds(ids); }
  function finishNudge() { if (nudge.current !== null) { nudge.current = null; store.endGesture(); } }
  function seek(time: number, scope: 'scene'|'transition' = transition && !transportView ? 'transition' : 'scene') { setPlaying(false); setTransportView(scope === 'scene'); setPathEditing(false); setPlayhead(clamp(time, 0, total)); }
  function play(scope: 'scene'|'transition' = 'scene') {
    if (playing) { setPlaying(false); return; }
    const begin = scope === 'transition' ? selectedSegment?.start || 0 : 0;
    const end = scope === 'transition' ? begin + (transition?.duration || 0) : total;
    const position = playhead < begin || playhead >= end - 1 ? begin : playhead;
    playStart.current = { time: performance.now(), position, end };
    setPreviewScope(scope); setTransportView(scope === 'scene'); setPlayhead(position); setPlaying(true);
  }

  useEffect(() => {
    if (!scene) return; let current = true;
    renderer.prepareScene(scene).then(() => { if (current) { setRenderRevision(value => value + 1); setRenderError(''); } }).catch(error => { if (current) setRenderError(error instanceof Error ? error.message : '描画を準備できませんでした。'); });
    return () => { current = false; };
  }, [scene, renderer]);
  useEffect(() => {
    if (!playing) return; let frame = 0;
    const tick = (time: number) => { const next = playStart.current.position + time - playStart.current.time; setPlayhead(Math.min(next, playStart.current.end)); if (next >= playStart.current.end) setPlaying(false); else frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [playing]);
  useEffect(() => {
    setPlaying(false); setTransportView(false); setPlayhead(0); setSelectedIds([]); setPathEditing(false);
  }, [scene?.id]);
  useEffect(() => {
    playStart.current.end = previewScope === 'transition' && transition ? (selectedSegment?.start || 0) + transition.duration : total;
    if (playhead > total) setPlayhead(total);
  }, [total, previewScope, selectedSegment?.start, transition?.duration]);
  useEffect(() => { if (scene) store.presence({ sceneId: scene.id, compositionId, selectedIds: activeIds }); }, [scene?.id, compositionId, activeIds.join(','), store]);
  useEffect(() => {
    function released(event: KeyboardEvent) { if (event.key.startsWith('Arrow')) finishNudge(); }
    window.addEventListener('keyup', released); window.addEventListener('blur', finishNudge); window.addEventListener('pointerdown', finishNudge, true);
    return () => { window.removeEventListener('keyup', released); window.removeEventListener('blur', finishNudge); window.removeEventListener('pointerdown', finishNudge, true); finishNudge(); };
  }, [store]);
  useEffect(() => { finishNudge(); }, [scene?.id, compositionId, activeIds.join(',')]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const element = event.target as HTMLElement;
      if (element.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="menuitem"]')) return;
      if (window.getSelection()?.toString()) return;
      if (event.code === 'Space' && element.closest('button, [role="tab"]')) return;
      if (!event.key.startsWith('Arrow')) finishNudge();
      const command = event.metaKey || event.ctrlKey;
      if (transportView && (['Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || command && ['d', 'g', 'a'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); notify('「この場面を編集」または Esc で編集に戻れます。'); return;
      }
      if (transportView && event.key === 'Escape') { event.preventDefault(); editMoment(); return; }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'v') pasteInPlace.current = event.shiftKey;
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? store.redo() : store.undo(); }
        if (event.key.toLowerCase() === 'd' && scene && activeIds.length) { event.preventDefault(); setSelectedIds(store.duplicate(scene.id, compositionId, activeIds)); }
        if (event.key.toLowerCase() === 'a' && scene) { event.preventDefault(); setSelectedIds(Object.keys(scene.objects).filter(id => scene.compositions[compositionId]?.states[id]?.visible)); }
        if (event.key.toLowerCase() === 'g' && scene && activeIds.length) { event.preventDefault(); event.shiftKey ? store.unlink(scene.id, activeIds) : store.link(scene.id, activeIds); }
        return;
      }
      const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (directions[event.key] && scene && activeIds.length) {
        event.preventDefault();
        const current = store.scene(scene.id);
        const ids = store.linkedIds(scene.id, activeIds).filter(id => current.compositions[compositionId]?.states[id]?.visible);
        if (!ids.length) return;
        const target = `${scene.id}/${compositionId}/${ids.join(',')}`;
        if (nudge.current !== target) { finishNudge(); store.beginGesture(); nudge.current = target; }
        const starts = Object.fromEntries(ids.map(id => { const state = current.compositions[compositionId].states[id]; return [id, { x: state.x, y: state.y }]; }));
        const [dx, dy] = directions[event.key]; const step = event.shiftKey ? 10 : 1;
        store.translate(scene.id, compositionId, starts, dx * step, dy * step);
        setPlaying(false); setTransportView(false); setTool('select');
        if (transition) select({ kind: 'composition', id: compositionId });
        return;
      }
      if (event.code === 'Space') { event.preventDefault(); play(transportView ? 'scene' : transition ? 'transition' : 'scene'); }
      if (event.key === 'Escape') { setSelectedIds([]); setTool('select'); setPlaying(false); setPathEditing(false); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && scene && activeIds.length) { event.preventDefault(); store.hide(scene.id, compositionId, activeIds); setSelectedIds([]); }
      const tools: Record<string, Tool> = { v: 'select', r: 'rectangle', o: 'circle', t: 'text', e: 'equation', p: 'path', l: 'arrow' };
      if (tools[event.key.toLowerCase()]) activateTool(tools[event.key.toLowerCase()]);
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  useEffect(() => {
    const textTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="menuitem"]');
    function copy(event: ClipboardEvent) {
      if (!scene || textTarget(event.target) || window.getSelection()?.toString() || !activeIds.length || !event.clipboardData) return;
      if (transportView) { event.preventDefault(); notify('編集する場面を開いてからコピーしてください。'); return; }
      const current = store.scene(scene.id);
      const ids = event.type === 'cut' ? activeIds.filter(id => !current.objects[id]?.locked) : activeIds;
      const data = copyObjects(current, compositionId, ids);
      if (!data.objects.length) return;
      try {
        const text = serializeObjects(data);
        event.clipboardData.setData(OBJECT_CLIPBOARD_MIME, text);
        event.clipboardData.setData('text/plain', text);
        event.preventDefault(); lastPaste.current = { text: '', count: 0, target: '' };
        if (event.type === 'cut') { store.hide(scene.id, compositionId, ids); setSelectedIds([]); }
        notify(`${data.objects.length} 個のオブジェクトを${event.type === 'cut' ? '切り取りました' : 'コピーしました'}`);
      } catch (error) { event.preventDefault(); notify(error instanceof Error ? error.message : 'コピーできませんでした'); }
    }
    function paste(event: ClipboardEvent) {
      if (!scene || textTarget(event.target) || window.getSelection()?.toString() || !event.clipboardData) return;
      const text = event.clipboardData.getData(OBJECT_CLIPBOARD_MIME) || event.clipboardData.getData('text/plain');
      const inPlace = pasteInPlace.current; pasteInPlace.current = false;
      try {
        const data = parseObjects(text);
        if (!data) return;
        event.preventDefault();
        if (transportView) { notify('編集する場面を開いてから貼り付けてください。'); return; }
        const target = `${scene.id}/${compositionId}`;
        const count = lastPaste.current.text === text && lastPaste.current.target === target ? lastPaste.current.count + 1 : 1;
        const ids = store.paste(scene.id, compositionId, data, inPlace ? 0 : count * 24);
        lastPaste.current = { text, count: inPlace ? 0 : count, target };
        setSelectedIds(ids); setTool('select'); select({ kind: 'composition', id: compositionId });
        notify(`${ids.length} 個のオブジェクトを貼り付けました`);
      } catch (error) { event.preventDefault(); notify(error instanceof Error ? error.message : '貼り付けできませんでした'); }
    }
    window.addEventListener('copy', copy); window.addEventListener('cut', copy); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('copy', copy); window.removeEventListener('cut', copy); window.removeEventListener('paste', paste); };
  });

  async function share() { try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { notify('リンク欄を選択してコピーしてください'); } }
  const participants = [...snapshot.peers].sort((a,b) => a.clientId === store.doc.clientID ? -1 : b.clientId === store.doc.clientID ? 1 : a.clientId-b.clientId);

  if (!project || !scene) return <div className="loading-screen"><img src="/poietra.svg" alt="Poietra"/><span>Opening your studio</span><div className="loading-line"/><ConnectionStatus snapshot={snapshot} onRetry={store.retryConnection} expanded/></div>;

  const context = { store, scene, selection, select, compositionId, selectedIds: activeIds, setSelectedIds: chooseObjects, tool, setTool, kernel, renderer, createFramePainter, playhead, seek, playing, play, previewScope, viewingPlayback: transportView, pathEditing, setPathEditing, peers: snapshot.peers, notify };
  const viewingPlayback = transportView;
  const currentFrame = viewingPlayback ? evaluateScene(scene, playhead, kernel) : compositionFrame(scene, scene.compositions[compositionId]);
  const transitionPreview = transition && (playing && previewScope === 'transition' || localTime > 0) ? transitionFrame(scene, transition, localTime, kernel) : null;

  return <Tooltip.Provider delay={450}><EditorContext.Provider value={context}><div className="studio" data-engine="wasm">
    <nav className="app-rail" aria-label="メインナビゲーション"><button className="brand" aria-label="Poietra の使い方" onClick={() => setHelpOpen(true)}><img src="/poietra.svg" alt=""/></button><div className="rail-actions"><IconButton label="Editor" active={rightTab === 'properties'} onClick={() => setRightTab('properties')}><BookOpen size={21}/></IconButton><IconButton label="AI assistant" active={rightTab === 'assistant'} onClick={() => setRightTab('assistant')}><Sparkles size={21}/></IconButton></div><div className="rail-bottom"><IconButton label="キーボードショートカット" onClick={() => setHelpOpen(true)}><Keyboard size={17}/></IconButton><button className="avatar own-avatar" style={{ background: store.color }} aria-label="プロフィールと共有" onClick={() => setShareOpen(true)}>{store.userName.startsWith('Guest ') ? store.userName.slice(-2) : store.userName.slice(0,2).toUpperCase()}</button></div></nav>
    <div className="project-heading"><button className="project-icon" aria-label="プロジェクトを開く" onClick={() => setProjectOpen(true)}>P</button><input aria-label="Project name" value={project.name} onChange={e => store.setProjectName(e.target.value)}/></div>
    <header className="topbar"><SceneTabs project={project} sceneId={scene.id} onChange={changeScene} onNew={newScene} store={store} notify={notify}/><div className="topbar-spacer"/><div className="history-actions"><IconButton label="元に戻す (⌘Z)" disabled={!snapshot.canUndo} onClick={() => store.undo()}><Undo2 size={15}/></IconButton><IconButton label="やり直す (⌘⇧Z)" disabled={!snapshot.canRedo} onClick={() => store.redo()}><Redo2 size={15}/></IconButton></div><ConnectionStatus snapshot={snapshot} onRetry={store.retryConnection}/><div className="participant-stack">{participants.slice(0,4).map(peer => <button className="avatar" key={peer.clientId} style={{ background: peer.color }} title={`${peer.name}${peer.clientId === store.doc.clientID ? '（あなた）' : ''}`} onClick={() => setShareOpen(true)}>{peer.name.startsWith('Guest ') ? peer.name.slice(-2) : peer.name.slice(0,2).toUpperCase()}</button>)}</div><button className="subtle-button share-button" onClick={() => setShareOpen(true)}><Share2 size={14}/><span>Share</span></button><button className="primary-button export-button" onClick={() => setExportOpen(true)} disabled={!exporter}><Film size={14}/><span>Export</span></button></header>
    <Sidebar onNewScene={newScene}/>
    <main className="editor-main"><div className={`workspace ${transition && !viewingPlayback ? 'transition-workspace' : ''}`}>
      <div className="workspace-heading"><div className="workspace-breadcrumb">{transition && !viewingPlayback ? <><span>{scene.compositions[transition.fromId]?.name}</span><ArrowRight size={17}/><span>{scene.compositions[transition.toId]?.name}</span></> : <><span>{viewingPlayback ? scene.name : scene.compositions[compositionId]?.name}</span><span className="muted workspace-subtitle">{viewingPlayback ? 'Preview' : 'Composition'}</span></>}</div>{transition && !viewingPlayback ? <button className={`subtle-button preview-button ${playing ? 'active' : ''}`} onClick={() => play('transition')}>{playing ? <Pause size={13} fill="currentColor"/> : <Play size={13} fill="currentColor"/>}Preview</button> : <span className="workspace-dimensions">{scene.width} × {scene.height}</span>}</div>
      {renderError ? <div className="render-error" role="alert">{renderError}</div> : !renderReady ? <div className="canvas-loading"><LoaderCircle size={20} className="loading-spinner"/></div> : transition && !viewingPlayback ? <><div className="compare-stages"><div className="compare-column"><div className="compare-label"><span>From</span>{scene.compositions[transition.fromId]?.name}</div><Stage frame={compositionFrame(scene, scene.compositions[transition.fromId])} compositionId={transition.fromId} interactive={false} prefix="from"/><div className="compare-caption">{activeIds.length === 1 ? scene.objects[activeIds[0]]?.name : 'Start state'}<span><ArrowRight size={12}/>{activeIds.length === 1 && !scene.compositions[transition.fromId].states[activeIds[0]]?.visible ? 'Enter' : 'Transition'}</span></div></div><div className="compare-column"><div className="compare-label"><span>To</span>{scene.compositions[transition.toId]?.name}</div><Stage frame={transitionPreview || compositionFrame(scene, scene.compositions[transition.toId])} compositionId={transition.toId} stateEditing={!transitionPreview} prefix="to"/><div className="compare-caption">{activeIds.length === 1 ? scene.objects[activeIds[0]]?.name : 'End state'}<span>{activeIds.length === 1 ? ANIMATION_LABEL(transition.tracks[activeIds[0]]?.type) : 'Composition'}</span></div></div></div><div className="preview-transport"><IconButton label={playing ? 'プレビューを停止' : 'Transition をプレビュー'} onClick={() => play('transition')}>{playing ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</IconButton><span>{ms(localTime)} / {ms(transition.duration)} ms</span><input aria-label="Transition preview position" type="range" min={0} max={transition.duration} value={localTime} step={1} onChange={e => seek((selectedSegment?.start || 0) + Number(e.target.value), 'transition')}/></div></> : <div className="main-stage-area"><Stage frame={currentFrame} compositionId={compositionId} interactive={!viewingPlayback} zoom={zoom}/><div className="floating-tools">{([[MousePointer2,'select','選択 (V)'],[Square,'rectangle','四角形 (R)'],[Circle,'circle','円 (O)'],[Spline,'path','ベジェ曲線 (P)'],[Sigma,'equation','数式 (E)'],[Type,'text','テキスト (T)'],[ArrowUpRight,'arrow','矢印 (L)'],[Minus,'numberline','数直線']] as const).map(([Icon,value,label]) => <IconButton key={value} label={label} active={tool===value} onClick={() => activateTool(value)}><Icon size={18} strokeWidth={1.5}/></IconButton>)}<div className="tool-divider"/><IconButton label="AI assistant" active={rightTab==='assistant'} onClick={() => setRightTab(rightTab==='assistant'?'properties':'assistant')}><Sparkles size={19}/></IconButton></div>{tool !== 'select' && <div className="tool-instruction">キャンバスをクリック、またはドラッグして追加<span>Esc でキャンセル</span></div>}</div>}
    </div><Timeline zoom={zoom} setZoom={setZoom}/></main>
    <aside className="right-panel"><div className="inspector-tabs"><button className={rightTab==='properties'?'selected':''} onClick={() => setRightTab('properties')}><SlidersHorizontal size={13}/>Design</button><button className={rightTab==='assistant'?'selected':''} onClick={() => setRightTab('assistant')}><Sparkles size={13}/>Assistant</button></div>{viewingPlayback ? <PlaybackPanel scene={scene} segment={playbackSegment} playhead={playhead} onEdit={() => editMoment()}/> : rightTab==='properties' && <Inspector/>}<div className="assistant-tab-content" hidden={viewingPlayback || rightTab!=='assistant'}><AssistantPanel/></div></aside>
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
    <ProjectDialog open={projectOpen} onOpenChange={setProjectOpen} project={project}/>
    <Modal open={shareOpen} onOpenChange={setShareOpen} title="A little better, together." description="同じリンクを開けば、このプロジェクトを一緒に編集できます。"><div className="share-link"><input aria-label="共有リンク" readOnly value={location.href} onFocus={e => e.currentTarget.select()}/><button className="primary-button" onClick={share}>{copied?<Check size={14}/>:<Copy size={14}/>}<span>{copied?'Copied':'Copy link'}</span></button></div><div className="share-participants"><h3>In this project <span>{participants.length}</span></h3>{participants.map(peer=><div key={peer.clientId}><span className="avatar" style={{ background:peer.color }}>{peer.name.slice(-2).toUpperCase()}</span><span>{peer.name}</span><small>{peer.clientId===store.doc.clientID?'You':'Editing'}</small></div>)}</div><label className="name-field">表示名<input value={name} onChange={e=>setName(e.target.value)} onBlur={()=>store.setName(name)} maxLength={40}/></label><div className="share-footer"><span><Link2 size={12}/>リンクを知っている人が編集できます</span><button className="text-button" onClick={()=>download(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),`${project.name}.poietra.json`)}><Download size={13}/>Save project</button></div></Modal>
    <Modal open={helpOpen} onOpenChange={setHelpOpen} title="An idea. Then, a little motion." description="Composition で場面を作り、Transition でその間の動きを組み立てます。"><div className="help-steps"><div><span>01</span><h3>Shape the moment</h3><p>図形や数式を配置。プロパティから色や大きさを調整します。</p></div><div><span>02</span><h3>Find the movement</h3><p>次の Composition を作り、Transition で個々の動きを重ねます。</p></div><div><span>03</span><h3>Make it yours</h3><p>友人や AI と仕上げて、ひとつの動画に。</p></div></div><div className="keyboard-shortcuts">{[['Space','再生 / 停止'],['V / R / O / P','選択 / 四角 / 円 / パス'],['Shift + click','複数選択'],['↑ ↓ ← → / Shift','1 px / 10 px 移動'],['⌘ / Ctrl + C / V','コピー / 貼り付け'],['⌘ / Ctrl + ⇧V','同じ位置に貼り付け'],['⌘ / Ctrl + D','複製'],['⌘ / Ctrl + G','連結'],['⌘ / Ctrl + Z','元に戻す'],['Delete','この場面から非表示']].map(([key,action])=><div key={key}><span>{action}</span><kbd>{key}</kbd></div>)}</div></Modal>
    {exporter && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} exporter={exporter} scene={scene} kernel={kernel} name={project.name}/>} 
  </div></EditorContext.Provider></Tooltip.Provider>;
}

function ANIMATION_LABEL(value: string | undefined) { return value ? value[0].toUpperCase()+value.slice(1) : 'Move'; }

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { Tabs } from '@base-ui/react/tabs';
import { ArrowRight, BookOpen, ChartNoAxesColumnIncreasing, Check, ChevronDown, Circle, Copy, Download, Film, LoaderCircle, MousePointer2, Pause, Play, Plus, Redo2, Send, Share2, Sigma, SlidersHorizontal, Sparkles, Spline, Square, Type, Undo2, X, ArrowUpRight, Minus, Keyboard, Link2 } from 'lucide-react';
import { EditorContext, type Tool } from './editor/context';
import { EditorStore } from './editor/store';
import { compositionFrame, evaluateScene, transitionFrame } from './engine/evaluate';
import type { MotionKernel } from './engine/kernel';
import type { ExportCapabilities, ExporterContract, ExportResult, RendererContract } from './engine/render-contract';
import { clamp, ms, sceneDuration, sceneSegments, type Selection } from '../shared/model';
import { Sidebar } from './ui/Sidebar';
import { Inspector } from './ui/Inspector';
import { Timeline } from './ui/Timeline';
import { Stage } from './ui/Stage';
import { AssistantPanel } from './ui/AssistantPanel';
import { IconButton, Modal } from './ui/components';
import { download } from './ui/utils';

export function App({ store, kernel, renderer, exporter }: { store: EditorStore; kernel: MotionKernel; renderer: RendererContract; exporter: ExporterContract | null }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot);
  const [sceneId, setSceneId] = useState('scene-1');
  const [requestedSelection, setRequestedSelection] = useState<Selection>({ kind: 'composition', id: 'comp-1' });
  const [selectedIds, setSelectedIds] = useState<string[]>([]); const [tool, setTool] = useState<Tool>('select');
  const [playhead, setPlayhead] = useState(0); const [playing, setPlaying] = useState(false); const [previewScope, setPreviewScope] = useState<'scene'|'transition'>('scene');
  const [transportView, setTransportView] = useState(false);
  const [pathEditing, setPathEditing] = useState(false); const [zoom, setZoom] = useState(1);
  const [rightTab, setRightTab] = useState<'properties'|'assistant'>('properties'); const [shareOpen, setShareOpen] = useState(false); const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false); const [copied, setCopied] = useState(false); const [name, setName] = useState(store.userName);
  const [toast, setToast] = useState(''); const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [renderRevision, setRenderRevision] = useState(0); const [renderError, setRenderError] = useState('');
  const renderReady = renderRevision > 0;
  const playStart = useRef({ time: 0, position: 0, end: 0 });
  const project = snapshot.project;
  const scene = project?.scenes[sceneId] ?? (project ? project.scenes[project.sceneOrder[0]] : null);
  const selection = scene && ((requestedSelection.kind === 'composition' && scene.compositions[requestedSelection.id]) || (requestedSelection.kind === 'transition' && scene.transitions[requestedSelection.id])) ? requestedSelection : { kind: 'composition' as const, id: scene?.compositionOrder[0] || '' };
  const transition = scene && selection.kind === 'transition' ? scene.transitions[selection.id] : null;
  const compositionId = transition ? transition.toId : selection.id;
  const activeIds = selectedIds.filter(id => !!scene?.objects[id]);
  const total = scene ? sceneDuration(scene) : 0;
  const segments = scene ? sceneSegments(scene) : [];
  const selectedSegment = segments.find(part => part.id === selection.id);
  const localTime = transition ? clamp(playhead - (selectedSegment?.start || 0), 0, transition.duration) : 0;

  function notify(message: string) { if (toastTimer.current) clearTimeout(toastTimer.current); setToast(message); toastTimer.current = setTimeout(() => setToast(''), 4000); }
  function select(next: Selection) { setPlaying(false); setTransportView(false); setRequestedSelection(next); setPathEditing(false); setPlayhead(segments.find(part => part.id === next.id)?.start || 0); }
  function changeScene(id: string) { setSceneId(id); setPlaying(false); setTransportView(false); setPlayhead(0); setSelectedIds([]); setPathEditing(false); const next = store.project().scenes[id]; if (next) setRequestedSelection({ kind: 'composition', id: next.compositionOrder[0] }); }
  function newScene() { const id = store.addScene(); changeScene(id); }
  function seek(time: number) { setPlaying(false); setTransportView(!transition); setPlayhead(clamp(time, 0, total)); }
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
  useEffect(() => { if (scene) store.presence({ sceneId: scene.id, compositionId, selectedIds: activeIds }); }, [scene?.id, compositionId, activeIds.join(','), store]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const element = event.target as HTMLElement;
      if (element.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? store.redo() : store.undo(); }
        if (event.key.toLowerCase() === 'd' && scene && activeIds.length) { event.preventDefault(); setSelectedIds(store.duplicate(scene.id, compositionId, activeIds)); }
        if (event.key.toLowerCase() === 'a' && scene) { event.preventDefault(); setSelectedIds(Object.keys(scene.objects).filter(id => scene.compositions[compositionId]?.states[id]?.visible)); }
        if (event.key.toLowerCase() === 'g' && scene && activeIds.length) { event.preventDefault(); event.shiftKey ? store.unlink(scene.id, activeIds) : store.link(scene.id, activeIds); }
        return;
      }
      if (event.code === 'Space') { event.preventDefault(); play(transition ? 'transition' : 'scene'); }
      if (event.key === 'Escape') { setSelectedIds([]); setTool('select'); setPlaying(false); setPathEditing(false); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && scene && activeIds.length) { event.preventDefault(); store.hide(scene.id, compositionId, activeIds); setSelectedIds([]); }
      const tools: Record<string, Tool> = { v: 'select', r: 'rectangle', o: 'circle', t: 'text', e: 'equation', p: 'path', l: 'arrow' };
      if (tools[event.key.toLowerCase()]) setTool(tools[event.key.toLowerCase()]);
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });

  async function share() { try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { notify('リンク欄を選択してコピーしてください'); } }
  const participants = [...snapshot.peers].sort((a,b) => a.clientId === store.doc.clientID ? -1 : b.clientId === store.doc.clientID ? 1 : a.clientId-b.clientId);

  if (!project || !scene) return <div className="loading-screen"><img src="/poietra.svg" alt="Poietra"/><span>Opening your studio</span><div className="loading-line"/><p>{snapshot.status === 'disconnected' ? '接続を確認しています。サーバーに再接続すると編集を再開できます。' : 'シーンを読み込んでいます'}</p><button className="subtle-button" onClick={() => store.provider.connect()}>再接続</button></div>;

  const context = { store, scene, selection, select, compositionId, selectedIds: activeIds, setSelectedIds, tool, setTool, kernel, renderer, playhead, seek, playing, play, previewScope, pathEditing, setPathEditing, peers: snapshot.peers, notify };
  const viewingPlayback = transportView;
  const currentFrame = viewingPlayback ? evaluateScene(scene, playhead, kernel) : compositionFrame(scene, scene.compositions[compositionId]);
  const transitionPreview = transition && (playing && previewScope === 'transition' || localTime > 0) ? transitionFrame(scene, transition, localTime, kernel) : null;

  return <Tooltip.Provider delay={450}><EditorContext.Provider value={context}><div className="studio" data-engine="wasm">
    <nav className="app-rail" aria-label="メインナビゲーション"><button className="brand" aria-label="Poietra の使い方" onClick={() => setHelpOpen(true)}><img src="/poietra.svg" alt=""/></button><div className="rail-actions"><IconButton label="Editor" active={rightTab === 'properties'} onClick={() => setRightTab('properties')}><BookOpen size={21}/></IconButton><IconButton label="AI assistant" active={rightTab === 'assistant'} onClick={() => setRightTab('assistant')}><Sparkles size={21}/></IconButton></div><div className="rail-bottom"><IconButton label="キーボードショートカット" onClick={() => setHelpOpen(true)}><Keyboard size={17}/></IconButton><button className="avatar own-avatar" style={{ background: store.color }} aria-label="プロフィールと共有" onClick={() => setShareOpen(true)}>{store.userName.startsWith('Guest ') ? store.userName.slice(-2) : store.userName.slice(0,2).toUpperCase()}</button></div></nav>
    <div className="project-heading"><span className="project-icon">P</span><input aria-label="Project name" value={project.name} onChange={e => store.setProjectName(e.target.value)}/></div>
    <header className="topbar"><Tabs.Root value={scene.id} onValueChange={value => changeScene(String(value))} className="scene-tabs"><Tabs.List className="scene-tab-list" aria-label="Scenes">{project.sceneOrder.map(id => <Tabs.Tab className="scene-tab" key={id} value={id}><ChartNoAxesColumnIncreasing size={13}/><span>{project.scenes[id]?.name}</span></Tabs.Tab>)}</Tabs.List></Tabs.Root><IconButton label="Scene を追加" onClick={newScene}><Plus size={14}/></IconButton><div className="topbar-spacer"/><div className="history-actions"><IconButton label="元に戻す (⌘Z)" disabled={!snapshot.canUndo} onClick={() => store.undo()}><Undo2 size={15}/></IconButton><IconButton label="やり直す (⌘⇧Z)" disabled={!snapshot.canRedo} onClick={() => store.redo()}><Redo2 size={15}/></IconButton></div><div className="connection-status" title={snapshot.status === 'connected' && snapshot.synced ? '共同編集に接続済み' : '変更はこのブラウザに保存され、再接続後に同期されます'}><i className={snapshot.status === 'connected' && snapshot.synced ? 'online' : 'offline'}/><span>{snapshot.status === 'connected' && snapshot.synced ? 'Live' : 'Offline'}</span></div><div className="participant-stack">{participants.slice(0,4).map(peer => <button className="avatar" key={peer.clientId} style={{ background: peer.color }} title={`${peer.name}${peer.clientId === store.doc.clientID ? '（あなた）' : ''}`} onClick={() => setShareOpen(true)}>{peer.name.startsWith('Guest ') ? peer.name.slice(-2) : peer.name.slice(0,2).toUpperCase()}</button>)}</div><button className="subtle-button share-button" onClick={() => setShareOpen(true)}><Share2 size={14}/><span>Share</span></button><button className="primary-button export-button" onClick={() => setExportOpen(true)} disabled={!exporter}><Film size={14}/><span>Export</span></button></header>
    <Sidebar onNewScene={newScene}/>
    <main className="editor-main"><div className={`workspace ${transition && !viewingPlayback ? 'transition-workspace' : ''}`}>
      <div className="workspace-heading"><div className="workspace-breadcrumb">{transition && !viewingPlayback ? <><span>{scene.compositions[transition.fromId]?.name}</span><ArrowRight size={17}/><span>{scene.compositions[transition.toId]?.name}</span></> : <><span>{viewingPlayback ? scene.name : scene.compositions[compositionId]?.name}</span><span className="muted workspace-subtitle">{viewingPlayback ? 'Preview' : 'Composition'}</span></>}</div>{transition && !viewingPlayback ? <button className={`subtle-button preview-button ${playing ? 'active' : ''}`} onClick={() => play('transition')}>{playing ? <Pause size={13} fill="currentColor"/> : <Play size={13} fill="currentColor"/>}Preview</button> : <span className="workspace-dimensions">{scene.width} × {scene.height}</span>}</div>
      {renderError ? <div className="render-error" role="alert">{renderError}</div> : !renderReady ? <div className="canvas-loading"><LoaderCircle size={20} className="loading-spinner"/></div> : transition && !viewingPlayback ? <><div className="compare-stages"><div className="compare-column"><div className="compare-label"><span>From</span>{scene.compositions[transition.fromId]?.name}</div><Stage frame={compositionFrame(scene, scene.compositions[transition.fromId])} compositionId={transition.fromId} interactive={false} prefix="from"/><div className="compare-caption">{activeIds.length === 1 ? scene.objects[activeIds[0]]?.name : 'Start state'}<span><ArrowRight size={12}/>{activeIds.length === 1 && !scene.compositions[transition.fromId].states[activeIds[0]]?.visible ? 'Enter' : 'Transition'}</span></div></div><div className="compare-column"><div className="compare-label"><span>To</span>{scene.compositions[transition.toId]?.name}</div><Stage frame={transitionPreview || compositionFrame(scene, scene.compositions[transition.toId])} compositionId={transition.toId} prefix="to"/><div className="compare-caption">{activeIds.length === 1 ? scene.objects[activeIds[0]]?.name : 'End state'}<span>{activeIds.length === 1 ? ANIMATION_LABEL(transition.tracks[activeIds[0]]?.type) : 'Composition'}</span></div></div></div><div className="preview-transport"><IconButton label={playing ? 'プレビューを停止' : 'Transition をプレビュー'} onClick={() => play('transition')}>{playing ? <Pause size={14} fill="currentColor"/> : <Play size={14} fill="currentColor"/>}</IconButton><span>{ms(localTime)} / {ms(transition.duration)} ms</span><input aria-label="Transition preview position" type="range" min={0} max={transition.duration} value={localTime} step={1} onChange={e => seek((selectedSegment?.start || 0) + Number(e.target.value))}/></div></> : <div className="main-stage-area"><Stage frame={currentFrame} compositionId={compositionId} interactive={!viewingPlayback} zoom={zoom}/><div className="floating-tools">{([[MousePointer2,'select','選択 (V)'],[Square,'rectangle','四角形 (R)'],[Circle,'circle','円 (O)'],[Spline,'path','ベジェ曲線 (P)'],[Sigma,'equation','数式 (E)'],[Type,'text','テキスト (T)'],[ArrowUpRight,'arrow','矢印 (L)'],[Minus,'numberline','数直線']] as const).map(([Icon,value,label]) => <IconButton key={value} label={label} active={tool===value} onClick={() => { setTool(value); setPlaying(false); }}><Icon size={18} strokeWidth={1.5}/></IconButton>)}<div className="tool-divider"/><IconButton label="AI assistant" active={rightTab==='assistant'} onClick={() => setRightTab(rightTab==='assistant'?'properties':'assistant')}><Sparkles size={19}/></IconButton></div>{tool !== 'select' && <div className="tool-instruction">キャンバスをクリック、またはドラッグして追加<span>Esc でキャンセル</span></div>}</div>}
    </div><Timeline zoom={zoom} setZoom={setZoom}/></main>
    <aside className="right-panel"><div className="inspector-tabs"><button className={rightTab==='properties'?'selected':''} onClick={() => setRightTab('properties')}><SlidersHorizontal size={13}/>Design</button><button className={rightTab==='assistant'?'selected':''} onClick={() => setRightTab('assistant')}><Sparkles size={13}/>Assistant</button></div>{rightTab==='properties'?<Inspector/>:<AssistantPanel/>}</aside>
    {toast && <div className="toast" role="status"><Check size={15}/>{toast}</div>}
    <Modal open={shareOpen} onOpenChange={setShareOpen} title="A little better, together." description="同じリンクを開けば、このプロジェクトを一緒に編集できます。"><div className="share-link"><input aria-label="共有リンク" readOnly value={location.href} onFocus={e => e.currentTarget.select()}/><button className="primary-button" onClick={share}>{copied?<Check size={14}/>:<Copy size={14}/>}<span>{copied?'Copied':'Copy link'}</span></button></div><div className="share-participants"><h3>In this project <span>{participants.length}</span></h3>{participants.map(peer=><div key={peer.clientId}><span className="avatar" style={{ background:peer.color }}>{peer.name.slice(-2).toUpperCase()}</span><span>{peer.name}</span><small>{peer.clientId===store.doc.clientID?'You':'Editing'}</small></div>)}</div><label className="name-field">表示名<input value={name} onChange={e=>setName(e.target.value)} onBlur={()=>store.setName(name)} maxLength={40}/></label><div className="share-footer"><span><Link2 size={12}/>リンクを知っている人が編集できます</span><button className="text-button" onClick={()=>download(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),`${project.name}.poietra.json`)}><Download size={13}/>Save project</button></div></Modal>
    <Modal open={helpOpen} onOpenChange={setHelpOpen} title="An idea. Then, a little motion." description="Composition で場面を作り、Transition でその間の動きを組み立てます。"><div className="help-steps"><div><span>01</span><h3>Shape the moment</h3><p>図形や数式を配置。プロパティから色や大きさを調整します。</p></div><div><span>02</span><h3>Find the movement</h3><p>次の Composition を作り、Transition で個々の動きを重ねます。</p></div><div><span>03</span><h3>Make it yours</h3><p>友人や AI と仕上げて、ひとつの動画に。</p></div></div><div className="keyboard-shortcuts">{[['Space','再生 / 停止'],['V / R / O / P','選択 / 四角 / 円 / パス'],['Shift + click','複数選択'],['⌘ / Ctrl + G','連結'],['⌘ / Ctrl + Z','元に戻す'],['Delete','この場面から非表示']].map(([key,action])=><div key={key}><span>{action}</span><kbd>{key}</kbd></div>)}</div></Modal>
    {exporter && <ExportDialog open={exportOpen} onOpenChange={setExportOpen} exporter={exporter} scene={scene} kernel={kernel} name={project.name}/>} 
  </div></EditorContext.Provider></Tooltip.Provider>;
}

function ANIMATION_LABEL(value: string | undefined) { return value ? value[0].toUpperCase()+value.slice(1) : 'Move'; }

function ExportDialog({ open, onOpenChange, exporter, scene, kernel, name }: { open: boolean; onOpenChange: (open:boolean)=>void; exporter: ExporterContract; scene: Parameters<ExporterContract['exportScene']>[0]; kernel: MotionKernel; name: string }) {
  const [capabilities,setCapabilities]=useState<ExportCapabilities|null>(null); const [format,setFormat]=useState<'mp4'|'webm'>('mp4'); const [fps,setFps]=useState<24|30|60>(30); const [resolution,setResolution]=useState('1280');
  const [progress,setProgress]=useState(0); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [result,setResult]=useState<ExportResult|null>(null); const abort=useRef<AbortController|null>(null);
  useEffect(()=>{if(open){setResult(null);setError('');exporter.getExportCapabilities().then(value=>{setCapabilities(value);if(!value.mp4&&value.webm)setFormat('webm');}).catch(failure=>setError(String(failure)));}},[open,exporter]);
  async function render() {setError('');setProgress(0);setBusy(true);const controller=new AbortController();abort.current=controller;try{const width=Number(resolution);const output=await exporter.exportScene(structuredClone(scene),kernel,{format,fps,width,height:Math.round(width*scene.height/scene.width/2)*2,onProgress:setProgress,signal:controller.signal});setResult(output);download(output.blob,`${name}-${scene.name}.${output.extension}`);}catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'書き出しに失敗しました。');}finally{setBusy(false);abort.current=null;}}
  return <Modal open={open} onOpenChange={next=>{if(!next)abort.current?.abort();onOpenChange(next);}} title="Ready for the world." description={`${scene.name} · ${(sceneDuration(scene)/1000).toFixed(2)} seconds`}><div className="export-settings"><label>Format<select value={format} onChange={e=>setFormat(e.target.value as 'mp4'|'webm')} disabled={busy}><option value="mp4" disabled={!capabilities?.mp4}>MP4</option><option value="webm" disabled={!capabilities?.webm}>WebM</option></select></label><label>Resolution<select value={resolution} onChange={e=>setResolution(e.target.value)} disabled={busy}><option value="1280">1280 × 720</option><option value="1920">1920 × 1080</option><option value="640">640 × 360</option></select></label><label>Frame rate<select value={fps} onChange={e=>setFps(Number(e.target.value) as 24|30|60)} disabled={busy}><option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option></select></label></div>{capabilities&&!capabilities.mp4&&!capabilities.webm&&<p className="inline-error">{capabilities.reason||'このブラウザは動画書き出しに対応していません。'}</p>}{error&&<p className="inline-error" role="alert">{error}</p>}{busy&&<div className="export-progress"><progress value={progress} max={1}/><span>{Math.round(progress*100)}%</span></div>}{result&&<p className="export-success"><Check size={15}/>書き出しました · {(result.blob.size/1024/1024).toFixed(1)} MB</p>}<div className="dialog-actions">{busy?<button className="subtle-button" onClick={()=>abort.current?.abort()}>Cancel</button>:<button className="subtle-button" onClick={()=>onOpenChange(false)}>Close</button>}<button className="primary-button" disabled={busy||!capabilities?.[format]} onClick={()=>void render()}>{busy?<LoaderCircle size={15} className="loading-spinner"/>:<Download size={15}/>}Export video</button></div></Modal>;
}

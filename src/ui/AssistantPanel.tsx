import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowUp, Check, ChevronRight, LoaderCircle, MessageCircle, Sparkles, X } from 'lucide-react';
import { useEditor } from '../editor/context';
import { proposalTargets, type ProposalTarget } from '../editor/ai-targets';
import { validateProposalForApply, type EditProposal } from '../../shared/ai';
import { chatHistory, codexPrompt, type ChatMessage as Message, type ChatScope } from '../../shared/chat';
import { LOCAL_ORIGIN } from '../../shared/document';

interface PendingRequest { controller: AbortController; scope: ChatScope; prompt: string; messageId: string }

export function AssistantPanel({ onOpenScene, onEditMoment }: { onOpenScene: (sceneId: string) => void; onEditMoment: () => void }) {
  const editor = useEditor();
  const chat = editor.store.chat;
  const messages = useSyncExternalStore(chat.subscribe, chat.snapshot);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null); const [error, setError] = useState('');
  const [retry, setRetry] = useState<{ prompt: string; messageId: string } | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null); const request = useRef<PendingRequest | null>(null);
  const currentScene = useRef(editor.scene.id); currentScene.current = editor.scene.id;
  const appliedIds = useRef(new Set<string>());
  const drafts = useRef(new Map<string, string>());

  function updatePrompt(value: string) { drafts.current.set(currentScene.current, value); setPrompt(value); }
  function restoreDraft(active: PendingRequest) {
    if (!drafts.current.get(active.scope.sceneId)) drafts.current.set(active.scope.sceneId, active.prompt);
    if (currentScene.current === active.scope.sceneId) setPrompt(drafts.current.get(active.scope.sceneId) || '');
  }

  useEffect(() => {
    let active = true; let checking = false; const health = new AbortController();
    const check = async () => {
      if (checking) return; checking = true;
      try {
        const response = await fetch('/api/health', { signal: health.signal });
        if (!response.ok) throw new Error('Health check failed');
        const data = await response.json(); if (active) setAvailable(data.ai === true);
      } catch { if (active) setAvailable(false); }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(check, 15000);
    return () => { active = false; clearInterval(timer); health.abort(); if (request.current) { request.current.controller.abort(); chat.patch(request.current.messageId, { status: 'cancelled' }); } request.current = null; };
  }, []);
  useEffect(() => {
    if (!editor.store.snapshot().synced) return;
    for (const message of messages) if (message.authorId === editor.store.chatAuthorId && message.status === 'pending' && message.id !== request.current?.messageId && !editor.peers.some(peer => peer.clientId === message.requestClientId)) chat.patch(message.id, { status: 'cancelled' });
  }, [messages, chat, editor.store, editor.peers]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending, editor.scene.id]);
  useEffect(() => {
    const active = request.current;
    if (active && active.scope.sceneId !== editor.scene.id) {
      active.controller.abort(); request.current = null; setPending(null);
      chat.patch(active.messageId, { status: 'cancelled' });
      restoreDraft(active); setError('Scene を切り替えたため、依頼を停止しました。');
    } else setError('');
    setPrompt(drafts.current.get(editor.scene.id) || ''); setRetry(null);
  }, [editor.scene.id]);

  function stop() {
    const active = request.current; if (!active) return;
    active.controller.abort(); request.current = null; setPending(null);
    chat.patch(active.messageId, { status: 'cancelled' });
    restoreDraft(active); setRetry(null); setError('依頼を停止しました。編集内容はそのままです。');
  }

  async function send(value = prompt, retryMessageId?: string, autoApply = false) {
    const text = value.trim(); if (!text) return;
    if (text.length > 3000) { setError('メッセージは 3,000 文字以内で入力してください。'); return; }
    const aiPrompt = codexPrompt(text);
    if (aiPrompt !== null && editor.viewingPlayback) { setError('「この場面を編集」で編集に戻ってから Codex に依頼してください。'); return; }
    if (aiPrompt !== null && request.current) { setError('Codex の返答を待つか、現在の依頼を停止してください。'); return; }
    if (aiPrompt === '') { setError('@codex の後に、頼みたいことを入力してください。'); return; }
    if (aiPrompt !== null && !available) { setError('Codex の接続を準備しています。メンバーへのメッセージは送れます。'); return; }
    if (aiPrompt !== null && editor.selectedIds.length > 100) { setError('Codex への依頼では、選択するオブジェクトを100個以内にしてください。'); return; }
    const selection = { ...editor.selection };
    const target = selection.kind === 'composition' ? editor.scene.compositions[selection.id]?.name : 'Transition';
    const names = editor.selectedIds.map(id => editor.scene.objects[id]?.name).filter(Boolean);
    const scope: ChatScope = { sceneId: editor.scene.id, selection, selectedIds: editor.selectedIds.slice(0, 100), label: `${editor.scene.name} · ${target || 'Composition'}${names.length ? ` · ${names.join(', ')}` : ''}`.slice(0, 2000) };
    const sceneMessages = chat.snapshot().filter(message => message.scope.sceneId === scope.sceneId);
    const last = sceneMessages.filter(message => message.authorId === editor.store.chatAuthorId).at(-1);
    const previousAttempt = retryMessageId ? sceneMessages.find(message => message.id === retryMessageId && message.authorId === editor.store.chatAuthorId)
      : aiPrompt !== null && last?.role === 'user' && (last.status === 'cancelled' || last.status === 'failed') && last.content === text ? last : undefined;
    const messageId = previousAttempt?.id || crypto.randomUUID();
    const history = chatHistory(chat.snapshot(), scope.sceneId, editor.store.chatAuthorId);
    const userMessage: Message = { id: messageId, role: 'user', content: text, scope, status: aiPrompt === null ? 'complete' : 'pending', mentionsCodex: aiPrompt !== null,
      requestClientId: editor.store.doc.clientID, authorId: editor.store.chatAuthorId, authorName: editor.store.userName.slice(0, 40), color: editor.store.color, createdAt: Date.now() };
    // Only the sender starts inference. Receiving a synchronized mention never calls the API.
    const active: PendingRequest = { controller: new AbortController(), scope, prompt: text, messageId };
    if (aiPrompt !== null) { request.current = active; setPending(active); }
    setError(''); setRetry(null);
    if (prompt.trim() === text) updatePrompt('');
    try {
      if (previousAttempt) chat.patch(messageId, { status: userMessage.status }); else chat.append(userMessage);
      if (aiPrompt === null) return;
      const response = await fetch('/api/ai/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: active.controller.signal,
        body: JSON.stringify({ roomId: editor.store.roomId, sceneId: scope.sceneId, compositionId: editor.compositionId, transitionId: selection.kind === 'transition' ? selection.id : null, selectedIds: scope.selectedIds, prompt: aiPrompt, history, supportsCompositionAppends: true }),
      });
      let data: EditProposal & { error?: string };
      try { data = await response.json(); }
      catch { throw new Error('応答を読み取れませんでした。もう一度お試しください。'); }
      // Aborting fetch is not sufficient: a response may already have reached response.json().
      if (request.current !== active || active.controller.signal.aborted || currentScene.current !== scope.sceneId) return;
      if (!response.ok) throw new Error(data.error || '編集案を作成できませんでした。');
      if (!data || typeof data.id !== 'string' || typeof data.message !== 'string' || !Array.isArray(data.changes) || !Number.isFinite(data.count)) throw new Error('編集案を読み取れませんでした。もう一度お試しください。');
      const scene = editor.store.project().scenes[scope.sceneId];
      if (!scene) throw new Error('編集対象の Scene が削除されています。');
      const assistantId = crypto.randomUUID();
      editor.store.doc.transact(() => {
        chat.patch(messageId, { status: 'complete' });
        chat.append({ id: assistantId, role: 'assistant', content: data.message, proposal: data, scope, replyTo: messageId, authorId: editor.store.chatAuthorId, authorName: 'Codex', color: '#a79bf3', createdAt: Date.now() });
      });
      // ⌘/Ctrl + Enter applies the guarded proposal as soon as it arrives; Undo stays the human's turn.
      if (autoApply && data.changes.length) applyRef.current(assistantId, true);
    } catch (failure) {
      if (aiPrompt === null) { setError('メッセージを保存できませんでした。もう一度お試しください。'); restoreDraft(active); }
      if (request.current === active && !active.controller.signal.aborted) {
        chat.patch(messageId, { status: 'failed' });
        setError(failure instanceof Error ? failure.message : '接続に失敗しました。'); setRetry({ prompt: text, messageId });
      }
    } finally { if (request.current === active) { request.current = null; setPending(null); } }
  }

  function apply(messageId: string, automatic = false) {
    const message = chat.snapshot().find(item => item.id === messageId);
    if (editor.viewingPlayback) { setError('編集に戻ってから適用してください。'); return; }
    if (!message?.proposal || message.authorId !== editor.store.chatAuthorId || message.applied || message.dismissed || appliedIds.current.has(message.id)) return;
    if (message.scope.sceneId !== editor.scene.id) { setError('対象の Scene に戻って適用してください。'); return; }
    try {
      validateProposalForApply(editor.store.doc, message.proposal);
      const targets = proposalTargets(message.proposal, editor.scene);
      editor.store.undoManager.stopCapturing();
      try { editor.store.doc.transact(() => { editor.store.applyProposal(message.proposal!); chat.patch(message.id, { applied: true }); }, LOCAL_ORIGIN); }
      finally { editor.store.undoManager.stopCapturing(); }
      appliedIds.current.add(message.id);
      const created = targets.findLast(target => target.created && target.selection.kind === 'transition') ?? targets.findLast(target => target.created);
      if (created) { editor.select(created.selection); editor.setSelectedIds(created.objectIds); }
      editor.notify(automatic ? 'Codex の編集案を即適用しました。Undo で戻せます' : '編集案を適用しました。Undo で戻せます'); setError(''); setRetry(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '適用できませんでした。'); }
  }
  // send() awaits the network; apply through the latest render so its scene and chat are current.
  const applyRef = useRef(apply); applyRef.current = apply;
  function showTarget(target: ProposalTarget) {
    const exists = target.selection.kind === 'composition' ? editor.scene.compositions[target.selection.id] : editor.scene.transitions[target.selection.id];
    if (!exists) { setError('編集案の対象が削除されています。今の状態でもう一度依頼してください。'); return; }
    editor.select(target.selection); editor.setSelectedIds(target.objectIds.filter(id => editor.scene.objects[id])); setError('');
  }

  const selectedTransition = editor.selection.kind === 'transition' ? editor.scene.transitions[editor.selection.id] : null;
  const canSuggestMotion = editor.selectedIds.length > 0 && Object.values(editor.scene.transitions).some(transition => editor.selectedIds.every(id => editor.scene.compositions[transition.fromId]?.states[id]?.visible && editor.scene.compositions[transition.toId]?.states[id]?.visible));
  const suggestions = editor.scene.compositionOrder.length === 1 && Object.keys(editor.scene.objects).length === 0
    ? ['円を作り、次の場面へ上向きの弧で動かして', '数式 E = mc^2 がゆっくり登場する次の場面を作って', '短い見出しが登場する2つの場面を作って']
    : editor.scene.compositionOrder.length === 1 && editor.selectedIds.length > 0
      ? ['次の場面を作り、選択した図形を右へ動かして', '次の場面で選択した図形をフェードアウトして', '選択した図形を黄色にして']
      : editor.selectedIds.length === 1 && editor.scene.objects[editor.selectedIds[0]]?.kind === 'path' && !selectedTransition
    ? ['この曲線を上に大きく曲げて', 'この曲線を黄色にして', '線を少し太くして']
    : canSuggestMotion
      ? ['選択した図形を上に弧を描いて動かして', '動きの開始を 100ms 遅らせて', '動き始めと終わりをなめらかにして']
      : selectedTransition
        ? ['登場を 200ms 早めて', '動きの開始を 100ms 遅らせて', '動き始めと終わりをなめらかにして']
        : ['円をもう少し大きくして、黄色にして', '星のイラストを生成して右上に置いて', '短い見出しのテキストを追加して'];
  const visibleMessages = messages;
  const addressingCodex = codexPrompt(prompt) !== null;

  return <div className="assistant-panel">
    <div className="assistant-heading"><span className="assistant-icon"><MessageCircle size={18}/></span><div><h2>Room chat</h2><p>みんなで相談。@codex で編集を依頼。</p></div></div>
    <div className="assistant-messages" role="log" aria-label="共同編集チャット" aria-live="polite">
      {visibleMessages.length === 0 && <div className="assistant-welcome"><p>この部屋のメンバーと、制作の相談を。<br/><strong>@codex</strong> で AI も会話に参加します。</p><div className="prompt-suggestions">{suggestions.map(text => <button key={text} onClick={() => updatePrompt(`@codex ${text}`)}><span>{text}</span><ChevronRight size={13}/></button>)}</div><small>AI の編集案は、依頼した人が確認して適用できます。</small></div>}
      {visibleMessages.map(message => {
        const own = message.authorId === editor.store.chatAuthorId;
        const targetScene = editor.store.snapshot().project?.scenes[message.scope.sceneId];
        const targets = message.proposal && targetScene ? proposalTargets(message.proposal, targetScene) : [];
        return <div key={message.id} className={`chat-message ${message.role}`}>
        <div className="chat-author">{message.role === 'user' ? <><span className="chat-avatar" style={{ background: message.color }}>{message.authorName.slice(0, 1)}</span>{message.authorName}{own && <small>You</small>}</> : <><Sparkles size={12}/>Codex</>}<time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
        {message.role === 'user' && <small className="muted">{message.scope.label}</small>}{message.scope.sceneId !== editor.scene.id && targetScene && <button className="chat-scene-link" onClick={() => onOpenScene(message.scope.sceneId)}>{targetScene.name} を開く<ChevronRight size={11}/></button>}<p>{message.content}</p>
        {message.status === 'pending' && <small className="muted">Codex に依頼中…</small>}
        {message.status === 'cancelled' && <small className="muted">停止しました</small>}
        {message.status === 'failed' && <small className="muted">Codex への依頼に失敗しました</small>}
        {own && message.mentionsCodex && (message.status === 'failed' || message.status === 'cancelled') && <button className="chat-scene-link" onClick={() => { if (message.scope.sceneId !== editor.scene.id) onOpenScene(message.scope.sceneId); drafts.current.set(message.scope.sceneId, message.content); if (message.scope.sceneId === editor.scene.id) setPrompt(message.content); composer.current?.focus(); }}>依頼を入力欄に戻す</button>}
        {message.proposal && message.proposal.changes.length > 0 && <div className="proposal-card">
          <span>{message.proposal.count} 件の編集</span>
          {message.applied ? <span className="applied"><Check size={13}/>Applied</span> : message.dismissed ? <span className="muted">Discarded</span> : !own ? <span className="muted">依頼した人が適用できます</span> : message.scope.sceneId !== editor.scene.id ? <span className="muted">対象の Scene で適用できます</span> : <div>
            <button className="primary-button small-button" disabled={editor.viewingPlayback} onClick={() => apply(message.id)}>Apply edits</button>
            <button className="icon-button" aria-label="編集案を破棄" onClick={() => chat.patch(message.id, { dismissed: true })}><X size={13}/></button>
          </div>}
          <div className="proposal-targets" aria-label="編集する対象">{targets.map(target => {
            const exists = target.selection.kind === 'composition' ? editor.scene.compositions[target.selection.id] : editor.scene.transitions[target.selection.id];
            return <div className="proposal-target" key={`${target.selection.kind}:${target.selection.id}`}><span>{target.label}</span><button className="subtle-button small-button" disabled={message.scope.sceneId !== editor.scene.id || target.created && !exists} onClick={() => showTarget(target)}>{target.created && !exists ? '適用後に表示' : '対象を表示'}</button></div>;
          })}</div>
        </div>}
      </div>; })}
      {pending && <div className="assistant-thinking" title={pending.scope.label}><LoaderCircle size={13} className="loading-spinner"/><span>Codex が考えています…</span><button onClick={stop}>停止</button></div>}
      <div ref={bottom}/>
    </div>
    <div className="assistant-composer">
      {error && <p className="inline-error" role="alert">{error}{retry && !pending && <button className="text-button" onClick={() => void send(retry.prompt, retry.messageId)}>再試行</button>}</p>}
      {editor.viewingPlayback && <p className="assistant-connection">AI への依頼・適用は編集画面で。<button className="text-button" onClick={onEditMoment}>この場面を編集</button></p>}
      {available === false && !error && <p className="assistant-connection">Codex の接続待ち · メンバーとは会話できます</p>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea ref={composer} aria-label="チャットメッセージ" placeholder="メンバーに送信、@codex で AI に依頼" value={prompt} onChange={event => updatePrompt(event.target.value)} maxLength={3000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(prompt, undefined, event.metaKey || event.ctrlKey); } }} rows={3}/>
        <div className="composer-bottom"><button className="mention-button" type="button" onClick={() => { updatePrompt(addressingCodex ? prompt : `@codex ${prompt}`); composer.current?.focus(); }}>@codex</button><span>{addressingCodex ? editor.scene.name : 'Everyone'}</span><button className="send-button" aria-label="送信" disabled={!prompt.trim() || addressingCodex && (!!pending || available !== true || editor.viewingPlayback)} type="submit"><ArrowUp size={17}/></button></div>
      </form><small>Enter で送信 · Shift + Enter で改行 · ⌘/Ctrl + Enter で @codex の編集案を即適用</small>
    </div>
  </div>;
}

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react';
import { useEditor } from '../editor/context';
import { proposalTargets, type ProposalTarget } from '../editor/ai-targets';
import { validateProposalForApply, type EditProposal } from '../../shared/ai';
import { trimAiHistory, type AiConversationTurn } from '../../shared/ai-conversation';
import type { Selection } from '../../shared/model';

interface RequestScope { sceneId: string; selection: Selection; selectedIds: string[]; label: string }
interface Message {
  id: string; role: 'user' | 'assistant'; content: string; scope: RequestScope;
  status?: 'pending' | 'complete' | 'failed' | 'cancelled';
  proposal?: EditProposal; targets?: ProposalTarget[]; applied?: boolean; dismissed?: boolean;
}
interface PendingRequest { controller: AbortController; scope: RequestScope; prompt: string; messageId: string }

export function AssistantPanel() {
  const editor = useEditor();
  const [messages, setMessages] = useState<Message[]>([]); const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null); const [error, setError] = useState('');
  const [retry, setRetry] = useState<{ prompt: string; messageId: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null); const request = useRef<PendingRequest | null>(null);
  const currentScene = useRef(editor.scene.id); currentScene.current = editor.scene.id;
  const appliedIds = useRef(new Set<string>());
  const messageState = useRef<Message[]>([]); const drafts = useRef(new Map<string, string>());

  function updateMessages(update: (previous: Message[]) => Message[]) {
    messageState.current = update(messageState.current); setMessages(messageState.current);
  }
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
    return () => { active = false; clearInterval(timer); health.abort(); request.current?.controller.abort(); request.current = null; };
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending, editor.scene.id]);
  useEffect(() => {
    const active = request.current;
    if (active && active.scope.sceneId !== editor.scene.id) {
      active.controller.abort(); request.current = null; setPending(null);
      updateMessages(previous => previous.map(item => item.id === active.messageId ? { ...item, status: 'cancelled' } : item));
      restoreDraft(active); setError('Scene を切り替えたため、依頼を停止しました。');
    } else setError('');
    setPrompt(drafts.current.get(editor.scene.id) || ''); setRetry(null);
  }, [editor.scene.id]);

  function stop() {
    const active = request.current; if (!active) return;
    active.controller.abort(); request.current = null; setPending(null);
    updateMessages(previous => previous.map(item => item.id === active.messageId ? { ...item, status: 'cancelled' } : item));
    restoreDraft(active); setRetry(null); setError('依頼を停止しました。編集内容はそのままです。');
  }

  async function send(value = prompt, retryMessageId?: string) {
    const text = value.trim(); if (!text || request.current) return;
    if (text.length > 3000) { setError('依頼は 3,000 文字以内で入力してください。'); return; }
    if (!available) { setError('AI の接続を準備しています。編集はそのまま続けられます。'); return; }
    const selection = { ...editor.selection };
    const target = selection.kind === 'composition' ? editor.scene.compositions[selection.id]?.name : 'Transition';
    const names = editor.selectedIds.map(id => editor.scene.objects[id]?.name).filter(Boolean);
    const scope: RequestScope = { sceneId: editor.scene.id, selection, selectedIds: [...editor.selectedIds], label: `${editor.scene.name} · ${target || 'Composition'}${names.length ? ` · ${names.join(', ')}` : ''}` };
    const sceneMessages = messageState.current.filter(message => message.scope.sceneId === scope.sceneId);
    const last = sceneMessages.at(-1);
    const previousAttempt = retryMessageId ? sceneMessages.find(message => message.id === retryMessageId)
      : last?.role === 'user' && (last.status === 'cancelled' || last.status === 'failed') && last.content === text ? last : undefined;
    const messageId = previousAttempt?.id || crypto.randomUUID();
    const history = trimAiHistory(sceneMessages.flatMap((message): AiConversationTurn[] => {
      if (message.role === 'user') return message.status === 'complete' ? [{ role: 'user', content: message.content }] : [];
      return [{ role: 'assistant', content: message.content, ...(message.proposal?.changes.length ? { proposalStatus: message.applied ? 'applied' as const : message.dismissed ? 'discarded' as const : 'proposed' as const } : {}) }];
    }));
    const active: PendingRequest = { controller: new AbortController(), scope, prompt: text, messageId };
    request.current = active; setPending(active); setError(''); setRetry(null);
    if (prompt.trim() === text) updatePrompt('');
    const userMessage: Message = { id: messageId, role: 'user', content: text, scope, status: 'pending' };
    updateMessages(previous => previousAttempt ? previous.map(item => item.id === messageId ? userMessage : item) : [...previous, userMessage]);
    try {
      const response = await fetch('/api/ai/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: active.controller.signal,
        body: JSON.stringify({ roomId: editor.store.roomId, sceneId: scope.sceneId, compositionId: editor.compositionId, transitionId: selection.kind === 'transition' ? selection.id : null, selectedIds: scope.selectedIds, prompt: text, history, supportsCompositionAppends: true }),
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
      const targets = proposalTargets(data, scene);
      updateMessages(previous => [...previous.map(item => item.id === messageId ? { ...item, status: 'complete' as const } : item), { id: crypto.randomUUID(), role: 'assistant', content: data.message, proposal: data, scope, targets }]);
    } catch (failure) {
      if (request.current === active && !active.controller.signal.aborted) {
        updateMessages(previous => previous.map(item => item.id === messageId ? { ...item, status: 'failed' } : item));
        setError(failure instanceof Error ? failure.message : '接続に失敗しました。'); setRetry({ prompt: text, messageId });
      }
    } finally { if (request.current === active) { request.current = null; setPending(null); } }
  }

  function apply(message: Message) {
    if (!message.proposal || message.applied || message.dismissed || appliedIds.current.has(message.id)) return;
    if (message.scope.sceneId !== editor.scene.id) { setError('対象の Scene に戻って適用してください。'); return; }
    try {
      validateProposalForApply(editor.store.doc, message.proposal);
      editor.store.applyProposal(message.proposal); appliedIds.current.add(message.id);
      updateMessages(previous => previous.map(item => item.id === message.id ? { ...item, applied: true } : item));
      const created = message.targets?.findLast(target => target.created && target.selection.kind === 'transition') ?? message.targets?.findLast(target => target.created);
      if (created) { editor.select(created.selection); editor.setSelectedIds(created.objectIds); }
      editor.notify('編集案を適用しました。Undo で戻せます'); setError(''); setRetry(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '適用できませんでした。'); }
  }
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
        : ['円をもう少し大きくして、黄色にして', '図形を中央に揃えて', '短い見出しのテキストを追加して'];
  const visibleMessages = messages.filter(message => message.scope.sceneId === editor.scene.id);

  return <div className="assistant-panel">
    <div className="assistant-heading"><span className="assistant-icon"><Sparkles size={18}/></span><div><h2>Make it move.</h2><p>あなたの意図を、ひとつずつ。</p></div></div>
    <div className="assistant-messages" role="log" aria-label="AI との編集履歴" aria-live="polite">
      {visibleMessages.length === 0 && <div className="assistant-welcome"><p>配置も、色も、動きのタイミングも。<br/>作りたい表現を話しかけてください。</p><div className="prompt-suggestions">{suggestions.map(text => <button key={text} onClick={() => updatePrompt(text)}><span>{text}</span><ChevronRight size={13}/></button>)}</div><small>変更内容を確認してから適用できます。</small></div>}
      {visibleMessages.map(message => <div key={message.id} className={`chat-message ${message.role}`}>
        <div className="chat-author">{message.role === 'user' ? 'You' : <><Sparkles size={12}/>Poietra</>}</div>
        {message.role === 'user' && <small className="muted">{message.scope.label}</small>}<p>{message.content}</p>
        {message.status === 'cancelled' && <small className="muted">停止しました</small>}
        {message.status === 'failed' && <small className="muted">送信できませんでした</small>}
        {message.proposal && message.proposal.changes.length > 0 && <div className="proposal-card">
          <span>{message.proposal.count} 件の編集</span>
          {message.applied ? <span className="applied"><Check size={13}/>Applied</span> : message.dismissed ? <span className="muted">Discarded</span> : <div>
            <button className="primary-button small-button" onClick={() => apply(message)}>Apply edits</button>
            <button className="icon-button" aria-label="編集案を破棄" onClick={() => updateMessages(previous => previous.map(item => item.id === message.id ? { ...item, dismissed: true } : item))}><X size={13}/></button>
          </div>}
          <div className="proposal-targets" aria-label="編集する対象">{message.targets?.map(target => {
            const exists = target.selection.kind === 'composition' ? editor.scene.compositions[target.selection.id] : editor.scene.transitions[target.selection.id];
            return <div className="proposal-target" key={`${target.selection.kind}:${target.selection.id}`}><span>{target.label}</span><button className="subtle-button small-button" disabled={target.created && !exists} onClick={() => showTarget(target)}>{target.created && !exists ? '適用後に表示' : '対象を表示'}</button></div>;
          })}</div>
        </div>}
      </div>)}
      {pending && <div className="assistant-thinking" title={pending.scope.label}><LoaderCircle size={13} className="loading-spinner"/><span>動きを考えています…</span><button onClick={stop}>停止</button></div>}
      <div ref={bottom}/>
    </div>
    <div className="assistant-composer">
      {error && <p className="inline-error" role="alert">{error}{retry && !pending && <button className="text-button" onClick={() => void send(retry.prompt, retry.messageId)}>再試行</button>}</p>}
      {available === false && !error && <p className="assistant-connection">AI の接続待ち</p>}
      <form onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea aria-label="AI への編集依頼" placeholder="どんな動きにしますか？" value={prompt} onChange={event => updatePrompt(event.target.value)} maxLength={3000} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} rows={3}/>
        <div className="composer-bottom"><span>{editor.selectedIds.length ? `${editor.selectedIds.length} selected` : editor.scene.name}</span><button className="send-button" aria-label="編集を依頼" disabled={!prompt.trim() || !!pending || available !== true} type="submit"><ArrowUp size={17}/></button></div>
      </form><small>作り手が、最後のひと手間を。</small>
    </div>
  </div>;
}

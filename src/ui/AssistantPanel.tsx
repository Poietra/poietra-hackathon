import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, LoaderCircle, Sparkles, X } from 'lucide-react';
import { useEditor } from '../editor/context';
import type { EditProposal } from '../../shared/ai';

interface Message { id: string; role: 'user' | 'assistant'; content: string; proposal?: EditProposal; applied?: boolean; dismissed?: boolean }
export function AssistantPanel() {
  const editor = useEditor(); const [messages, setMessages] = useState<Message[]>([]); const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false); const [available, setAvailable] = useState<boolean | null>(null); const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null); const request = useRef<AbortController | null>(null);
  useEffect(() => { let active = true; const check = () => fetch('/api/health').then(response => response.json()).then(data => { if (active) setAvailable(!!data.ai); }).catch(() => { if (active) setAvailable(false); }); void check(); const timer = setInterval(check, 15000); return () => { active = false; clearInterval(timer); request.current?.abort(); }; }, []);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }); }, [messages, busy]);
  async function send(value = prompt) {
    if (!value.trim() || busy) return;
    if (!available) { setError('AI の接続を準備しています。編集はそのまま続けられます。'); return; }
    setError(''); setBusy(true); setPrompt(''); const text = value.trim();
    setMessages(previous => [...previous, { id: crypto.randomUUID(), role: 'user', content: text }]);
    const abort = new AbortController(); request.current = abort;
    try {
      const response = await fetch('/api/ai/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ roomId: editor.store.roomId, sceneId: editor.scene.id, compositionId: editor.compositionId, transitionId: editor.selection.kind === 'transition' ? editor.selection.id : null, selectedIds: editor.selectedIds, prompt: text }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '編集案を作成できませんでした。');
      setMessages(previous => [...previous, { id: data.id, role: 'assistant', content: data.message, proposal: data }]);
    } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '接続に失敗しました。'); }
    finally { if (request.current === abort) { request.current = null; setBusy(false); } }
  }
  function apply(message: Message) { if (!message.proposal) return; try { editor.store.applyProposal(message.proposal); setMessages(previous => previous.map(item => item.id === message.id ? { ...item, applied: true } : item)); editor.notify('編集案を適用しました。Undo で戻せます'); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : '適用できませんでした。'); } }
  return <div className="assistant-panel"><div className="assistant-heading"><span className="assistant-icon"><Sparkles size={18}/></span><div><h2>Make it move.</h2><p>あなたの意図を、ひとつずつ。</p></div></div><div className="assistant-messages">{messages.length === 0 && <div className="assistant-welcome"><p>配置も、色も、動きのタイミングも。<br/>作りたい表現を話しかけてください。</p><div className="prompt-suggestions">{['円をもう少し大きくして、黄色にして','数式の登場を 200ms 早めて','図形を中央に揃えて'].map(text => <button key={text} onClick={() => { setPrompt(text); }}><span>{text}</span><ChevronRight size={13}/></button>)}</div><small>変更内容を確認してから適用できます。</small></div>}{messages.map(message => <div key={message.id} className={`chat-message ${message.role}`}><div className="chat-author">{message.role === 'user' ? 'You' : <><Sparkles size={12}/>Poietra</>}</div><p>{message.content}</p>{message.proposal && message.proposal.count > 0 && <div className="proposal-card"><span>{message.proposal.count} 件の編集</span>{message.applied ? <span className="applied"><Check size={13}/>Applied</span> : message.dismissed ? <span className="muted">Discarded</span> : <div><button className="primary-button small-button" onClick={() => apply(message)}>Apply edits</button><button className="icon-button" aria-label="編集案を破棄" onClick={() => setMessages(previous => previous.map(item => item.id === message.id ? { ...item, dismissed: true } : item))}><X size={13}/></button></div>}</div>}</div>)}{busy && <div className="assistant-thinking"><LoaderCircle size={13} className="loading-spinner"/><span>動きを考えています…</span><button onClick={() => { request.current?.abort(); request.current = null; setBusy(false); }}>停止</button></div>}<div ref={bottom}/></div><div className="assistant-composer">{error && <p className="inline-error" role="alert">{error}</p>}{available === false && !error && <p className="assistant-connection">AI の接続待ち</p>}<form onSubmit={e => { e.preventDefault(); void send(); }}><textarea aria-label="AI への編集依頼" placeholder="どんな動きにしますか？" value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} rows={3}/><div className="composer-bottom"><span>{editor.selectedIds.length ? `${editor.selectedIds.length} selected` : editor.scene.name}</span><button className="send-button" aria-label="編集を依頼" disabled={!prompt.trim() || busy} type="submit"><ArrowUp size={17}/></button></div></form><small>作り手が、最後のひと手間を。</small></div></div>;
}

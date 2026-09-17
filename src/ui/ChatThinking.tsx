import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';

/** A shared request has one waiting indicator; only its sender can stop it. */
export function ChatThinking({ active, authorName, onStop }: { active: boolean; authorName: string; onStop?: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const node = element.current;
    if (!active || !node) return;
    const visibility = () => setPageVisible(!document.hidden);
    visibility();
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { root: node.closest('.assistant-messages') });
    observer.observe(node);
    document.addEventListener('visibilitychange', visibility);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', visibility); };
  }, [active]);
  return <div ref={element} className="assistant-thinking" data-animate={active && inView && pageVisible} role="status" aria-label={`Codex が考えています · ${authorName} の依頼`}>
    <span className="assistant-thinking-icon" aria-hidden="true"><Sparkles size={15}/></span>
    <div className="assistant-thinking-copy"><strong>Codex</strong><span>考えています<span className="sr-only">…</span><span className="assistant-thinking-dots" aria-hidden="true"><i className="assistant-thinking-dot"/><i className="assistant-thinking-dot"/><i className="assistant-thinking-dot"/></span></span></div>
    {onStop && <button type="button" onClick={onStop}>停止</button>}
  </div>;
}

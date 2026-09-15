import { useCallback, useEffect, useState } from 'react';
import { Check, LockKeyhole, MousePointer2, Move, X } from 'lucide-react';
import { cn } from './utils';
import './OperationFeedback.css';

export interface OperationStatus {
  label: string;
  detail?: string;
  kind: 'active' | 'complete' | 'cancelled' | 'locked' | 'idle';
}

/** Announce completed gestures once; pointer movement remains quiet for screen readers. */
export function useOperationFeedback(scope: string) {
  const [entry, setEntry] = useState<{ scope: string; status: OperationStatus } | null>(null);
  const report = useCallback((status: OperationStatus | null) => setEntry(status ? { scope, status } : null), [scope]);
  useEffect(() => {
    if (!entry || !['complete', 'cancelled'].includes(entry.status.kind)) return;
    const timer = window.setTimeout(() => setEntry(current => current === entry ? null : current), 2800);
    return () => window.clearTimeout(timer);
  }, [entry]);
  return { feedback: entry?.scope === scope ? entry.status : null, report };
}

export function OperationFeedback({ status, className }: { status: OperationStatus | null; className?: string }) {
  const Icon = status?.kind === 'complete' ? Check : status?.kind === 'cancelled' ? X : status?.kind === 'locked' ? LockKeyhole : status?.kind === 'active' ? Move : MousePointer2;
  const announcement = status && ['complete', 'cancelled'].includes(status.kind) ? `${status.label}${status.detail ? ` · ${status.detail}` : ''}` : '';
  return <div className={cn('operation-feedback', className)} data-feedback-state={status?.kind || 'empty'}>
    {status && <div className="operation-feedback-content"><Icon size={13} aria-hidden="true"/><span className="operation-feedback-label">{status.label}</span>{status.detail && <span className="operation-feedback-detail">{status.detail}</span>}</div>}
    <span className="operation-feedback-announcement" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>;
}

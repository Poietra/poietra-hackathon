import { useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip } from '@base-ui/react/tooltip';
import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from './utils';

export function IconButton({ label, active, className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return <Tooltip.Root><Tooltip.Trigger {...props} disabled={disabled} render={<button disabled={disabled}/>} aria-label={label} className={cn('icon-button', active && 'active', className)}>{children}</Tooltip.Trigger><Tooltip.Portal><Tooltip.Positioner sideOffset={7}><Tooltip.Popup className="tooltip">{label}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal></Tooltip.Root>;
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={cn('property-field', className)}><span>{label}</span>{children}</label>;
}

export function NumberInput({ value, onChange, label, suffix, min = -10000, max = 10000, step = 1 }: { value: number; onChange: (value: number) => void; label: string; suffix?: string; min?: number; max?: number; step?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const dirty = useRef(false);
  function commit() { if (dirty.current && draft !== null && draft.trim() !== '') { const number = Number(draft); if (Number.isFinite(number)) onChange(Math.min(max, Math.max(min, number))); } dirty.current = false; setDraft(null); }
  return <span className="number-input"><input aria-label={label} type="number" step={step} min={min} max={max} value={draft ?? Math.round(value * 100) / 100} onFocus={() => { dirty.current = false; setDraft(String(Math.round(value * 100) / 100)); }} onChange={event => { dirty.current = true; setDraft(event.target.value); }} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur(); } if (event.key === 'Escape') { dirty.current = false; event.currentTarget.blur(); } }} />{suffix && <span>{suffix}</span>}</span>;
}

export function Modal({ open, onOpenChange, title, description, children, className }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; className?: string }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Backdrop className="dialog-backdrop" /><Dialog.Popup className={cn('dialog', className)}><div className="dialog-heading"><Dialog.Title className="text-balance">{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="閉じる"><X size={17} /></Dialog.Close></div>{description && <Dialog.Description className="dialog-description text-pretty">{description}</Dialog.Description>}{children}</Dialog.Popup></Dialog.Portal></Dialog.Root>;
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="property-section"><div className="section-heading"><h3>{title}</h3>{action}</div>{children}</section>;
}

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent, type TextareaHTMLAttributes } from 'react';
import { applyTexCompletion, matchTexCompletions, texCompletionContext, type TexCompletion } from './tex-completions';
import './TexInput.css';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void };

/** A LaTeX textarea with command completion; the caller owns the value like a plain textarea. */
export function TexTextarea({ value, onChange, onKeyDown, onKeyUp, onSelect, onClick, onFocus, onBlur, ...props }: Props) {
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  // Set after the owner has re-rendered the accepted text, so the caret lands inside the snippet.
  const pending = useRef<{ text: string; caret: number } | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState({ key: '', index: 0 });
  const [dismissed, setDismissed] = useState('');

  const context = caret === null ? null : texCompletionContext(value, caret);
  const key = context ? `${context.start}:${context.query}` : '';
  const items = context ? matchTexCompletions(context.query) : [];
  const open = items.length > 0 && key !== dismissed && !(items.length === 1 && context && items[0].insert === `\\${context.query}`);
  const selected = active.key === key ? Math.min(active.index, items.length - 1) : 0;

  useLayoutEffect(() => {
    const target = pending.current, element = textarea.current;
    if (!target || !element || element.value !== target.text) return;
    pending.current = null;
    element.setSelectionRange(target.caret, target.caret);
    setCaret(target.caret);
  });

  function sync() {
    const element = textarea.current;
    setCaret(element && document.activeElement === element ? element.selectionStart : null);
  }
  function accept(item: TexCompletion) {
    if (!context || caret === null) return;
    const next = applyTexCompletion(value, context.start, caret, item);
    pending.current = next;
    setDismissed('');
    onChange(next.text);
    textarea.current?.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    onKeyDown?.(event);
    if (!open || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive({ key, index: (selected + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length });
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      accept(items[selected]);
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      setDismissed(key);
    }
  }
  const tracked = <E extends SyntheticEvent<HTMLTextAreaElement>>(handler?: (event: E) => void) => (event: E) => { handler?.(event); sync(); };

  return <div className="tex-input">
    <textarea {...props} ref={textarea} value={value} aria-autocomplete="list" aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open ? `${id}-${selected}` : undefined}
      onChange={event => { pending.current = null; onChange(event.target.value); setCaret(event.target.selectionStart); }}
      onKeyDown={keyDown} onKeyUp={tracked(onKeyUp)} onSelect={tracked(onSelect)} onClick={tracked(onClick)} onFocus={tracked(onFocus)}
      onBlur={event => { onBlur?.(event); setCaret(null); }}/>
    {open && <ul className="tex-completions" id={`${id}-list`} role="listbox" aria-label="LaTeX の候補">
      {items.map((item, index) => <li key={item.label} id={`${id}-${index}`} role="option" aria-selected={index === selected} className={index === selected ? 'active' : undefined}
        onMouseDown={event => event.preventDefault()} onClick={() => accept(item)} onMouseEnter={() => setActive({ key, index })}>
        <code>{item.label}</code>{item.hint && <span>{item.hint}</span>}
      </li>)}
    </ul>}
  </div>;
}

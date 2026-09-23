'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ComposerHandle {
  /** Focus with the caret at the end, so seeded text can be typed onto. */
  focus: () => void;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (v: string) => void;
    onSend: () => void;
    busy?: boolean;
    placeholder?: string;
  }
>(function Composer({ value, onChange, onSend, busy, placeholder }, handle) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(handle, () => ({
    focus() {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.scrollIntoView({ block: 'nearest' });
    },
  }));

  // Grow with content instead of scrolling inside a fixed box.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // "/" focuses the composer, the way search boxes behave everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const send = () => {
    if (busy || !value.trim()) return;
    onSend();
  };

  return (
    <div
      className={cn(
        'flex items-end gap-2 rounded-2xl border border-border-base bg-surface p-2',
        'focus-within:border-border-strong transition-colors',
      )}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={busy}
        placeholder={placeholder ?? 'Type a trade…'}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') ref.current?.blur();
        }}
        className={cn(
          'max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm',
          'placeholder:text-fg-subtle focus:outline-none disabled:opacity-50',
        )}
      />
      <button
        type="button"
        onClick={send}
        disabled={busy || !value.trim()}
        aria-label="Send"
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors',
          'bg-accent text-accent-fg hover:opacity-90',
          'disabled:cursor-not-allowed disabled:bg-border-base disabled:text-fg-subtle',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        )}
      >
        <ArrowUp size={15} />
      </button>
    </div>
  );
});

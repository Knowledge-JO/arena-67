'use client';

import { MessageSquare, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationSummary } from '@/lib/types';

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  disabled,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2.5">
        <button
          type="button"
          onClick={onNew}
          disabled={disabled}
          className="flex w-full items-center gap-2 rounded-lg border border-border-base px-3 py-2 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-raised disabled:opacity-50"
        >
          <Plus size={13} />
          New conversation
        </button>
      </div>

      <nav className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {conversations.length === 0 && (
          <p className="px-2.5 py-4 text-[11px] leading-relaxed text-fg-subtle">
            Conversations are saved here, and the desk can recall what was said
            in them.
          </p>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(c.id)}
            className={cn(
              'mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
              c.id === activeId
                ? 'bg-surface-raised text-fg'
                : 'text-fg-muted hover:bg-surface-raised/60 hover:text-fg',
              'disabled:opacity-60',
            )}
          >
            <MessageSquare size={12} className="shrink-0 opacity-60" />
            <span className="truncate">{c.title}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

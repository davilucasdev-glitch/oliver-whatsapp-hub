'use client';

import type { Tag } from '@/lib/types';
import { cn } from '@/lib/utils';

export function TagPicker({ tags, selected, onChange }: { tags: Tag[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            type="button"
            key={t.id}
            onClick={() => onChange(on ? selected.filter((x) => x !== t.id) : [...selected, t.id])}
            className={cn(
              'cursor-pointer rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors',
              on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
            )}
            aria-pressed={on}
          >
            {t.name}
          </button>
        );
      })}
      {tags.length === 0 && <span className="text-xs text-muted-foreground">Nenhuma tag criada.</span>}
    </div>
  );
}

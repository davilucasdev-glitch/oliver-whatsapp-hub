import { Badge } from '@/components/ui/badge';
import type { ContactListItem, Tag } from '@/lib/types';

export function ConsentBadge({ c }: { c: Pick<ContactListItem, 'optIn' | 'optOut'> }) {
  if (c.optOut) return <Badge tone="danger">Pediu para sair</Badge>;
  if (c.optIn) return <Badge tone="success">Opt-in</Badge>;
  return <Badge>Sem consentimento</Badge>;
}

export function TagChips({ tags, max = 4 }: { tags: Tag[]; max?: number }) {
  if (!tags.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {tags.slice(0, max).map((t) => (
        <Badge key={t.id} tone="brand" className="font-medium">
          {t.name}
        </Badge>
      ))}
      {tags.length > max && <Badge>+{tags.length - max}</Badge>}
    </span>
  );
}

/** "+5511988887777" → "(11) 98888-7777"; internacionais ficam como estão. */
export function formatPhone(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function displayName(c: { name: string | null; phone: string }): string {
  return c.name?.trim() || formatPhone(c.phone);
}

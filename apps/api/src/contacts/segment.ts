import type { Prisma } from '@prisma/client';
import { z } from 'zod';

/**
 * Segmento = filtro de contatos. Usado na lista de contatos e, na etapa 6, nas campanhas.
 */
export const segmentSchema = z.object({
  search: z.string().trim().max(100).optional(),
  tagsAny: z.array(z.string()).default([]), // tem pelo menos uma destas tags (ids)
  tagsAll: z.array(z.string()).default([]), // tem todas estas tags (ids)
  excludeTags: z.array(z.string()).default([]), // não tem nenhuma destas tags (ids)
  consent: z.enum(['any', 'optIn', 'optOut', 'noConsent']).default('any'),
  /** sem mensagem do cliente há pelo menos N dias (ou nunca escreveu) */
  inactiveDays: z.coerce.number().int().min(1).max(3650).optional(),
});

export type Segment = z.infer<typeof segmentSchema>;

export function segmentWhere(s: Segment, now = new Date()): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [];
  if (s.search) {
    const digits = s.search.replace(/\D/g, '');
    and.push({
      OR: [
        { name: { contains: s.search, mode: 'insensitive' } },
        { email: { contains: s.search, mode: 'insensitive' } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
      ],
    });
  }
  if (s.tagsAny.length) and.push({ tags: { some: { tagId: { in: s.tagsAny } } } });
  for (const t of s.tagsAll) and.push({ tags: { some: { tagId: t } } });
  if (s.excludeTags.length) and.push({ tags: { none: { tagId: { in: s.excludeTags } } } });
  if (s.consent === 'optIn') and.push({ optIn: true, optOut: false });
  if (s.consent === 'optOut') and.push({ optOut: true });
  if (s.consent === 'noConsent') and.push({ optIn: false, optOut: false });
  if (s.inactiveDays) {
    const cutoff = new Date(now.getTime() - s.inactiveDays * 86_400_000);
    and.push({ OR: [{ lastInboundAt: null }, { lastInboundAt: { lt: cutoff } }] });
  }
  return and.length ? { AND: and } : {};
}

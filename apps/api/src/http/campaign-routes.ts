import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  campaignInputSchema,
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  estimateAudience,
  getCampaignDetail,
  getMinDaysBetween,
  listCampaigns,
  listRecipients,
  pauseCampaign,
  previewCampaign,
  recipientsCsv,
  resumeCampaign,
  sendCampaignTest,
  setMinDaysBetween,
  startCampaign,
  unscheduleCampaign,
  updateCampaign,
} from '../campaigns/service.js';
import { segmentSchema } from '../contacts/segment.js';
import type { Deps } from '../deps.js';
import { HttpError, parse } from './errors.js';

const segmentInput = segmentSchema.omit({ consent: true }).default({ tagsAny: [], tagsAll: [], excludeTags: [] });

export async function campaignRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;

  app.get('/campaigns', async () => ({ campaigns: await listCampaigns(deps), minDaysBetween: await getMinDaysBetween(deps) }));

  app.put('/campaigns/settings', async (req) => {
    const { minDaysBetween } = parse(z.object({ minDaysBetween: z.number().int().min(0, 'mínimo 0').max(60, 'máximo 60 dias') }), req.body);
    await setMinDaysBetween(deps, minDaysBetween);
    return { minDaysBetween };
  });

  app.post('/campaigns/estimate', async (req) => {
    const b = parse(
      z.object({
        segment: segmentInput,
        phoneNumberId: z.string().optional(),
        windowStartHour: z.number().int().optional(),
        windowEndHour: z.number().int().optional(),
      }),
      req.body,
    );
    return estimateAudience(deps, b.segment, b);
  });

  app.post('/campaigns/preview', async (req) => {
    const b = parse(
      z.object({
        templateId: z.string().min(1, 'escolha o template'),
        variables: z.object({ header: z.array(z.unknown()).default([]), body: z.array(z.unknown()).default([]) }).default({ header: [], body: [] }),
        headerMediaUrl: z.string().nullish(),
        segment: segmentInput,
        contactId: z.string().optional(),
      }),
      req.body,
    );
    return previewCampaign(deps, b);
  });

  app.post('/campaigns', async (req, reply) => {
    const c = await createCampaign(deps, parse(campaignInputSchema, req.body));
    return reply.code(201).send({ campaign: c });
  });
  app.get('/campaigns/:id', async (req) => getCampaignDetail(deps, idOf(req)));
  /** Campanha do painel do site: só a administradora aprova (inicia, agenda ou retoma) — regra do documento. */
  const painelGuard = async (req: FastifyRequest) => {
    const c = await deps.db.campaign.findUnique({ where: { id: idOf(req) }, select: { source: true } });
    if (c?.source === 'painel' && req.user?.role !== 'ADMIN') throw new HttpError(403, 'Campanha que veio do painel só sai com a aprovação de um administrador (arte e público).');
  };
  app.put('/campaigns/:id', async (req) => {
    await painelGuard(req);
    return { campaign: await updateCampaign(deps, idOf(req), parse(campaignInputSchema, req.body)) };
  });
  app.delete('/campaigns/:id', async (req) => {
    await deleteCampaign(deps, idOf(req));
    return { ok: true };
  });

  app.post('/campaigns/:id/start', async (req) => {
    await painelGuard(req);
    return { campaign: await startCampaign(deps, idOf(req)) };
  });
  app.post('/campaigns/:id/unschedule', async (req) => {
    await unscheduleCampaign(deps, idOf(req));
    return { ok: true };
  });
  app.post('/campaigns/:id/pause', async (req) => {
    await pauseCampaign(deps, idOf(req));
    return { ok: true };
  });
  app.post('/campaigns/:id/resume', async (req) => {
    await painelGuard(req);
    await resumeCampaign(deps, idOf(req));
    return { ok: true };
  });
  app.post('/campaigns/:id/cancel', async (req) => {
    await cancelCampaign(deps, idOf(req));
    return { ok: true };
  });
  app.post('/campaigns/:id/duplicate', async (req) => ({ campaign: await duplicateCampaign(deps, idOf(req)) }));
  app.post('/campaigns/:id/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { phone } = parse(z.object({ phone: z.string().trim().min(8, 'informe o telefone') }), req.body);
    return sendCampaignTest(deps, idOf(req), phone);
  });

  app.get('/campaigns/:id/recipients', async (req) => {
    const q = parse(
      z.object({ filter: z.string().optional(), page: z.coerce.number().int().min(1).default(1) }),
      req.query,
    );
    return listRecipients(deps, idOf(req), q.filter, q.page);
  });
  app.get('/campaigns/:id/recipients.csv', async (req, reply) => {
    const csv = await recipientsCsv(deps, idOf(req));
    return reply
      .header('Content-Disposition', `attachment; filename="campanha-${idOf(req)}.csv"`)
      .type('text/csv; charset=utf-8')
      .send(csv);
  });
}

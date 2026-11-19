/**
 * Dados iniciais / de exemplo. Idempotente: pode rodar várias vezes.
 *   npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import { setSetting, SETTINGS } from '../src/settings.js';

const db = new PrismaClient();

async function main(): Promise<void> {
  const phoneNumberId = process.env.META_DEFAULT_PHONE_NUMBER_ID;
  const wabaId = process.env.META_WABA_ID;
  if (phoneNumberId && wabaId) {
    await db.phoneNumber.upsert({
      where: { phoneNumberId },
      create: { phoneNumberId, wabaId, displayName: 'Oliver — Principal', role: 'BOTH', status: 'CONNECTED' },
      update: {},
    });
    console.log(`Número principal cadastrado (${phoneNumberId}).`);
  } else {
    console.log('META_DEFAULT_PHONE_NUMBER_ID/META_WABA_ID vazios: nenhum número cadastrado.');
  }

  await setSetting(db, SETTINGS.botEnabled, true);
  await setSetting(db, SETTINGS.campaignMinDaysBetween, 7);
  await setSetting(db, SETTINGS.businessHours, {
    timezone: 'America/Sao_Paulo',
    // [DEFINIR] horário de atendimento humano — 0=domingo … 6=sábado
    days: { 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: ['09:00', '13:00'] },
  });

  const tags = ['comprou árabe', 'comprou suplemento', 'VIP', 'inativo 60 dias'];
  for (const name of tags) await db.tag.upsert({ where: { name }, create: { name }, update: {} });

  const quick = [
    { shortcut: '/oi', title: 'Saudação', body: 'Olá! Aqui é da Oliver Cosmetics 💜 Como posso te ajudar?' },
    { shortcut: '/aguarde', title: 'Aguarde', body: 'Só um instante, já estou verificando para você!' },
  ];
  for (const q of quick) await db.quickReply.upsert({ where: { shortcut: q.shortcut }, create: q, update: {} });

  // Contatos de exemplo (com opt-in registrado)
  const samples = [
    { phone: '+5511988887777', name: 'Maria Souza (exemplo)', tag: 'comprou árabe' },
    { phone: '+5521977776666', name: 'João Lima (exemplo)', tag: 'comprou suplemento' },
  ];
  for (const s of samples) {
    const tag = await db.tag.findUniqueOrThrow({ where: { name: s.tag } });
    const c = await db.contact.upsert({
      where: { phone: s.phone },
      create: { phone: s.phone, name: s.name, optIn: true, optInAt: new Date(), optInSource: 'seed:exemplo' },
      update: {},
    });
    await db.contactTag.upsert({
      where: { contactId_tagId: { contactId: c.id, tagId: tag.id } },
      create: { contactId: c.id, tagId: tag.id },
      update: {},
    });
  }
  console.log('Seed concluído.');
}

main()
  .catch((err: Error) => {
    console.error('Falha no seed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => void db.$disconnect());

/**
 * Sobe a Graph API simulada na porta 4010 (META_GRAPH_BASE_URL=http://localhost:4010).
 * Mostra no console cada mensagem que o sistema "envia" ao WhatsApp.
 */
import { startMockMeta } from '../src/dev/mock-meta.js';

const port = Number(process.env.MOCK_META_PORT ?? 4010);
// Com o .env carregado, devolve recibos de entrega ao webhook da API (relatório das campanhas em dev).
const secret = process.env.META_APP_SECRET;
const apiUrl = process.env.MOCK_META_WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3001}/webhook`;
const statusWebhook = secret && process.env.MOCK_META_STATUS !== 'off' ? { url: apiUrl, secret, wabaId: process.env.META_WABA_ID || 'WABA_DEV' } : undefined;
const mock = await startMockMeta(port, true, statusWebhook);
// Templates novos ficam aprovados 10 s depois (na Meta de verdade leva de minutos a horas).
mock.autoApproveMs = Number(process.env.MOCK_META_APPROVE_MS ?? 10_000);
if (statusWebhook) console.log(`Recibos de entrega → ${apiUrl}`);
console.log(`Meta simulada em ${mock.url}`);
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));

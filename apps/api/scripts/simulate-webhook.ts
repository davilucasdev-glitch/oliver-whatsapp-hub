/**
 * Envia ao /webhook da API um payload ASSINADO igual ao da Meta, simulando um cliente.
 *
 *   npm run simulate:webhook -w apps/api -- "Oi, tem perfume árabe?" 5511988887777 "Maria Souza"
 */
import { inboundTextPayload } from '../src/dev/payloads.js';
import { signMetaPayload } from '../src/whatsapp/signature.js';

const [text = 'Olá! Mensagem de teste', from = '5511988887777', name = 'Cliente Teste'] = process.argv.slice(2);
const apiUrl = process.env.SIMULATE_API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
const secret = process.env.META_APP_SECRET;
if (!secret) throw new Error('META_APP_SECRET não definido no .env');

const payload = inboundTextPayload({
  wabaId: process.env.META_WABA_ID || 'WABA_DEV',
  phoneNumberId: process.env.META_DEFAULT_PHONE_NUMBER_ID || 'PNID_DEV',
  from,
  name,
  text,
});
const raw = JSON.stringify(payload);
const res = await fetch(`${apiUrl}/webhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaPayload(raw, secret) },
  body: raw,
});
console.log(`POST /webhook → ${res.status}`, await res.text());

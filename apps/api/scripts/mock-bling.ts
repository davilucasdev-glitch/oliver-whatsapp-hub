/**
 * Sobe o Bling simulado na porta 4020. No .env:
 *   BLING_API_BASE_URL=http://localhost:4020/Api/v3
 *   BLING_OAUTH_BASE_URL=http://localhost:4020/Api/v3/oauth
 *   BLING_CLIENT_ID=mock-client-id   BLING_CLIENT_SECRET=mock-client-secret
 */
import { startMockBling } from '../src/dev/mock-bling.js';

const port = Number(process.env.MOCK_BLING_PORT ?? 4020);
const mock = await startMockBling(port, true);
console.log(`Bling simulado em ${mock.url} (${mock.products.length} produtos de exemplo)`);
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));

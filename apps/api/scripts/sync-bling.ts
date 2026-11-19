/**
 * npm run sync:bling            → sincroniza agora (só busca o detalhe do que mudou)
 * npm run sync:bling -- --full  → busca o detalhe de todos os produtos
 */
import { BlingNotConnectedError } from '../src/bling/client.js';
import { syncProducts } from '../src/bling/sync.js';
import { env } from '../src/config/env.js';
import { disconnectPrisma, prisma } from '../src/lib/prisma.js';

const full = process.argv.includes('--full');
const deps = { env: env(), db: prisma() };
try {
  console.log(`Sincronizando produtos do Bling${full ? ' (completo)' : ''}…`);
  const r = await syncProducts(deps, { full, trigger: 'cli' });
  console.log(
    `Pronto em ${(r.ms / 1000).toFixed(1)}s: ${r.listed} na listagem, ${r.created} novos, ${r.updated} atualizados, ` +
      `${r.details} detalhes lidos, ${r.deactivated} marcados como inativos, ${r.calls} chamadas à API.`,
  );
} catch (err) {
  console.error(err instanceof BlingNotConnectedError ? err.message : `Falhou: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await disconnectPrisma();
}

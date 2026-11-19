/**
 * Sobe o Oliver Hub em MODO DE TESTE nesta máquina (sem Docker): banco local, Meta/Bling/Claude simulados,
 * API e painel. Abre o navegador em http://localhost:3000 quando tudo estiver no ar.
 * Uso: dois cliques em "Iniciar Oliver Hub.cmd" (ou: node scripts/iniciar-dev.mjs). Ctrl+C encerra tudo.
 * Os logs de cada parte ficam em .logs/.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'apps', 'api');
const logs = path.join(root, '.logs');
fs.mkdirSync(logs, { recursive: true });

// O .env vale mais que variáveis antigas do Windows (ex.: ANTHROPIC_BASE_URL apontando para a API real).
const dotenv = Object.fromEntries(
  fs
    .readFileSync(path.join(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/\s+#.*$/, '').trim()];
    }),
);
const env = { ...process.env, ...dotenv, LOG_PRETTY: 'false', FORCE_COLOR: '0' };

const children = [];
const log = (msg) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
  });

async function waitPort(port, name, seconds = 120) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} não subiu em ${seconds}s. Veja .logs/${name}.log`);
}

function start(name, cmd, cwd) {
  const out = fs.openSync(path.join(logs, `${name}.log`), 'w');
  const child = spawn(cmd, { cwd, env, shell: true, stdio: ['ignore', out, out], windowsHide: true });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) log(`⚠ ${name} parou (código ${code}). Veja .logs/${name}.log`);
  });
  return child;
}

async function service(name, port, cmd, cwd) {
  if (await portOpen(port)) {
    log(`✔ ${name} já estava rodando (porta ${port})`);
    return;
  }
  log(`… iniciando ${name}`);
  start(name, cmd, cwd);
  await waitPort(port, name);
  log(`✔ ${name} no ar (porta ${port})`);
}

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  log('Encerrando…');
  for (const c of children) {
    try {
      execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* já tinha saído */
    }
  }
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

console.log('\n  Oliver WhatsApp Hub — MODO DE TESTE (Meta, Bling e Claude simulados)\n');
try {
  await service('banco', 5433, 'npx tsx scripts/dev-db.ts', api);
  await Promise.all([
    service('meta-simulada', 4010, 'npx tsx scripts/mock-meta.ts', api),
    service('bling-simulado', 4020, 'npx tsx scripts/mock-bling.ts', api),
    service('claude-simulado', 4030, 'npx tsx scripts/mock-claude.ts', api),
  ]);
  log('… atualizando o banco (migrations)');
  execSync('node scripts/prisma.mjs migrate deploy', { cwd: api, env, stdio: 'ignore' });
  await service('api', 3001, 'npx tsx src/index.ts', api);
  await service('painel', 3000, 'npm run dev -w apps/web', root);
  log('✔ Tudo no ar. Abrindo http://localhost:3000');
  execSync('start "" http://localhost:3000', { shell: true, stdio: 'ignore' });
  console.log(`\n  Painel:  http://localhost:3000`);
  console.log(`  Acesso de teste: ${dotenv.DEV_ADMIN_EMAIL ?? '(veja DEV_ADMIN_EMAIL no .env)'} — senha em DEV_ADMIN_PASSWORD no arquivo .env`);
  console.log('  Deixe esta janela aberta. Para desligar tudo: Ctrl+C ou feche a janela.\n');
} catch (err) {
  log(`✘ ${err.message}`);
  stopAll();
}

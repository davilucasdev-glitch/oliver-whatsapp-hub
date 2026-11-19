// Executa o CLI do Prisma carregando o .env da raiz do monorepo (se existir).
// Em Docker as variáveis já vêm do ambiente e o arquivo é ignorado.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const envFile = path.join(root, '.env');
if (existsSync(envFile) && !process.env.DATABASE_URL) process.loadEnvFile(envFile);

const require = createRequire(import.meta.url);
const cli = path.resolve(path.dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit', cwd: path.resolve(import.meta.dirname, '..') });
process.exit(r.status ?? 1);

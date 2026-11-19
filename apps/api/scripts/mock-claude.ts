/**
 * Claude simulado na porta 4030 (regras simples, não é IA). No .env:
 *   ANTHROPIC_BASE_URL=http://localhost:4030
 *   ANTHROPIC_API_KEY=sk-ant-mock-0000000000000000000000
 * Para usar o Claude de verdade, apague ANTHROPIC_BASE_URL e coloque a sua chave.
 */
import { startMockClaude } from '../src/dev/mock-claude.js';

const port = Number(process.env.MOCK_CLAUDE_PORT ?? 4030);
const mock = await startMockClaude(port, true);
console.log(`Claude simulado em ${mock.url}`);
process.on('SIGINT', () => void mock.close().then(() => process.exit(0)));

import { pino, type Logger } from 'pino';

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info');
const pretty = process.env.NODE_ENV === 'development' && process.env.LOG_PRETTY !== 'false';

export const logger: Logger = pino({
  level,
  base: { app: 'oliver-hub' },
  redact: {
    paths: ['*.accessToken', '*.token', '*.password', 'headers.authorization', 'req.headers.authorization'],
    censor: '[oculto]',
  },
  ...(pretty ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } } : {}),
});

export function childLogger(scope: string): Logger {
  return logger.child({ scope });
}

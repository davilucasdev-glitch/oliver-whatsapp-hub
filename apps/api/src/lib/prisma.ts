import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

export function prisma(): PrismaClient {
  client ??= new PrismaClient({
    log: process.env.PRISMA_LOG === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

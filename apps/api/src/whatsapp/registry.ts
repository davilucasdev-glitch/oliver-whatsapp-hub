import type { PhoneNumber } from '@prisma/client';
import type { Env } from '../config/env.js';
import { decrypt } from '../lib/crypto.js';
import { MetaCloudProvider } from './meta-cloud-provider.js';
import type { WhatsAppProvider } from './provider.js';

export type ProviderFactory = (number: Pick<PhoneNumber, 'id' | 'phoneNumberId' | 'accessTokenEnc'>) => WhatsAppProvider;

/** Cria (e guarda em cache) o provedor oficial de cada número cadastrado. */
export function createProviderFactory(env: Env): ProviderFactory {
  const cache = new Map<string, { tokenEnc: string | null; provider: WhatsAppProvider }>();
  return (number) => {
    const hit = cache.get(number.id);
    if (hit && hit.tokenEnc === number.accessTokenEnc) return hit.provider;
    const accessToken = number.accessTokenEnc ? decrypt(number.accessTokenEnc, env.ENCRYPTION_KEY) : env.META_ACCESS_TOKEN;
    const provider = new MetaCloudProvider({
      phoneNumberId: number.phoneNumberId,
      accessToken,
      baseUrl: env.META_GRAPH_BASE_URL,
      apiVersion: env.META_GRAPH_VERSION,
    });
    cache.set(number.id, { tokenEnc: number.accessTokenEnc, provider });
    return provider;
  };
}

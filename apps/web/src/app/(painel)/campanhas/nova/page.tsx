'use client';

import { PageHeader } from '@/components/app-shell';
import { CampaignForm } from '@/components/campaigns/campaign-form';

export default function NovaCampanhaPage() {
  return (
    <>
      <PageHeader title="Nova campanha" description="Envio por template aprovado, só para quem autorizou, no ritmo seguro do número." />
      <CampaignForm />
    </>
  );
}

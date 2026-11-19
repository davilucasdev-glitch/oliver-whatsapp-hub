'use client';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { PageHeader } from '@/components/app-shell';
import { CampaignForm } from '@/components/campaigns/campaign-form';
import { fetcher } from '@/lib/api';
import type { CampaignDetail } from '@/lib/types';

export default function EditarCampanhaPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useSWR<CampaignDetail>(`/campaigns/${id}`, fetcher, { revalidateOnFocus: false });
  return (
    <>
      <PageHeader title="Editar campanha" description={data?.campaign.name} />
      {error && <p className="text-sm text-muted-foreground">{(error as Error).message}</p>}
      {data && (data.campaign.status === 'DRAFT' || data.campaign.status === 'SCHEDULED') && <CampaignForm initial={data.campaign} />}
      {data && data.campaign.status !== 'DRAFT' && data.campaign.status !== 'SCHEDULED' && (
        <p className="text-sm text-muted-foreground">Esta campanha já começou e não pode mais ser editada. Use &quot;Duplicar&quot; para criar outra parecida.</p>
      )}
    </>
  );
}

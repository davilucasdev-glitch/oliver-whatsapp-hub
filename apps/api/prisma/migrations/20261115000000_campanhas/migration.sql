-- Etapa 6: campanhas (motor de envio com ritmo por número, relatório por destinatário)
ALTER TYPE "RecipientStatus" ADD VALUE 'SENDING' AFTER 'PENDING';

ALTER TABLE "PhoneNumber" ADD COLUMN "campaignNextSendAt" TIMESTAMP(3);

ALTER TABLE "Campaign" ADD COLUMN "headerMediaUrl" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "totalRecipients" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Campaign" ADD COLUMN "audienceBuiltAt" TIMESTAMP(3);
ALTER TABLE "Campaign" ADD COLUMN "waitingReason" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "lastError" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "pausedAt" TIMESTAMP(3);
CREATE INDEX "Campaign_status_scheduledAt_idx" ON "Campaign"("status", "scheduledAt");

ALTER TABLE "CampaignRecipient" ADD COLUMN "messageId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "readAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "failedAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN "optedOutAt" TIMESTAMP(3);
CREATE INDEX "CampaignRecipient_waMessageId_idx" ON "CampaignRecipient"("waMessageId");
CREATE INDEX "CampaignRecipient_contactId_sentAt_idx" ON "CampaignRecipient"("contactId", "sentAt");

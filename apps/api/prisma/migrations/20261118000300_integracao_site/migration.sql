-- Prioridade 3: API para o site/painel, campanha vinda do painel (arte + público) e carrinho abandonado
ALTER TYPE "RelationKind" ADD VALUE 'CARRINHO';

ALTER TABLE "Campaign" ADD COLUMN "source" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "sourceRef" TEXT;

CREATE TABLE "CampaignArt" (
    "id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignArt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SiteMessage" (
    "id" TEXT NOT NULL,
    "ref" TEXT,
    "phone" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "messageId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteMessage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SiteMessage_ref_key" ON "SiteMessage"("ref");
CREATE INDEX "SiteMessage_messageId_idx" ON "SiteMessage"("messageId");

CREATE TABLE "AbandonedCart" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "items" JSONB NOT NULL,
    "total" DOUBLE PRECISION,
    "link" TEXT NOT NULL,
    "recoveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AbandonedCart_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AbandonedCart_ref_key" ON "AbandonedCart"("ref");
CREATE INDEX "AbandonedCart_updatedAt_idx" ON "AbandonedCart"("updatedAt");

CREATE TABLE "SiteWebhookLog" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "httpStatus" INTEGER,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteWebhookLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SiteWebhookLog_createdAt_idx" ON "SiteWebhookLog"("createdAt");

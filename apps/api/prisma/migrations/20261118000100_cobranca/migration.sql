-- Cobrança e crediário: cópia das contas a receber do Bling + registro de cada cobrança enviada
CREATE TYPE "ChargeKind" AS ENUM ('LEMBRETE', 'VENCE_HOJE', 'ATRASO', 'PAGAMENTO');
CREATE TYPE "ChargeStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "Receivable" (
    "blingId" TEXT NOT NULL,
    "contactBlingId" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "phone" TEXT,
    "phoneSource" TEXT,
    "valor" DOUBLE PRECISION NOT NULL,
    "remaining" DOUBLE PRECISION NOT NULL,
    "remainingKnown" BOOLEAN NOT NULL DEFAULT true,
    "vencimento" TEXT NOT NULL,
    "emissao" TEXT NOT NULL,
    "situacao" INTEGER NOT NULL,
    "orderBlingId" TEXT,
    "orderNumber" TEXT,
    "lojaId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "lastPaymentAmount" DOUBLE PRECISION,
    "lastPaymentAt" TIMESTAMP(3),
    "paymentSeq" INTEGER NOT NULL DEFAULT 0,
    "seenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("blingId")
);
CREATE INDEX "Receivable_contactBlingId_idx" ON "Receivable"("contactBlingId");
CREATE INDEX "Receivable_situacao_vencimento_idx" ON "Receivable"("situacao", "vencimento");

CREATE TABLE "ChargeNotice" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "ChargeKind" NOT NULL,
    "status" "ChargeStatus" NOT NULL,
    "contactBlingId" TEXT NOT NULL,
    "contactName" TEXT,
    "receivableIds" JSONB NOT NULL,
    "amount" DOUBLE PRECISION,
    "balance" DOUBLE PRECISION,
    "variables" JSONB,
    "phone" TEXT,
    "templateName" TEXT,
    "reason" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChargeNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChargeNotice_key_key" ON "ChargeNotice"("key");
CREATE INDEX "ChargeNotice_contactBlingId_createdAt_idx" ON "ChargeNotice"("contactBlingId", "createdAt");
CREATE INDEX "ChargeNotice_createdAt_idx" ON "ChargeNotice"("createdAt");

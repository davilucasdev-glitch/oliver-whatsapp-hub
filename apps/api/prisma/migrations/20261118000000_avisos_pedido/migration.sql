-- Avisos de pedido: situação vista por último de cada pedido do Bling + registro de cada aviso
CREATE TYPE "OrderNoticeKind" AS ENUM ('RECEBIDO', 'SEPARANDO', 'PRONTO_RETIRAR', 'ENVIADO', 'ENTREGUE', 'CANCELADO');
CREATE TYPE "OrderNoticeStatus" AS ENUM ('SENT', 'SKIPPED', 'FAILED');

CREATE TABLE "OrderState" (
    "blingOrderId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "lojaId" TEXT,
    "situacaoId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderState_pkey" PRIMARY KEY ("blingOrderId")
);

CREATE TABLE "OrderNotice" (
    "id" TEXT NOT NULL,
    "blingOrderId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "kind" "OrderNoticeKind" NOT NULL,
    "status" "OrderNoticeStatus" NOT NULL,
    "reason" TEXT,
    "customerName" TEXT,
    "phone" TEXT,
    "sentTo" TEXT,
    "templateName" TEXT,
    "contactId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrderNotice_blingOrderId_kind_key" ON "OrderNotice"("blingOrderId", "kind");
CREATE INDEX "OrderNotice_updatedAt_idx" ON "OrderNotice"("updatedAt");

-- Prioridade 2: avisos para a equipe, relacionamento (avaliação, aniversário, recompra) e fornecedores

-- equipe: WhatsApp de cada pessoa e quais avisos ela recebe
ALTER TABLE "User" ADD COLUMN "phone" TEXT;
ALTER TABLE "User" ADD COLUMN "alertNewOrders" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "alertStuck" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "alertDaily" BOOLEAN NOT NULL DEFAULT false;

-- pedidos: desde quando estão na situação atual + nome/contato (aviso interno mostra nº e nome)
ALTER TABLE "OrderState" ADD COLUMN "situacaoSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "OrderState" ADD COLUMN "contactBlingId" TEXT;
ALTER TABLE "OrderState" ADD COLUMN "contactName" TEXT;
ALTER TABLE "OrderState" ADD COLUMN "orderDate" TEXT;
CREATE INDEX "OrderState_situacaoId_situacaoSince_idx" ON "OrderState"("situacaoId", "situacaoSince");
CREATE INDEX "OrderState_contactBlingId_idx" ON "OrderState"("contactBlingId");

-- contato: aniversário e última compra (copiados do Bling) + fornecedor
ALTER TABLE "Contact" ADD COLUMN "birthDate" TEXT;
ALTER TABLE "Contact" ADD COLUMN "lastOrderDate" TEXT;
ALTER TABLE "Contact" ADD COLUMN "blingCheckedAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "isSupplier" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "AlertKind" AS ENUM ('NOVOS_SEPARANDO', 'PARADOS', 'RESUMO_DIA');
CREATE TYPE "RelationKind" AS ENUM ('AVALIACAO', 'ANIVERSARIO', 'RECOMPRA');
CREATE TYPE "SupplierSendKind" AS ENUM ('PEDIDO_COMPRA', 'COTACAO');
CREATE TYPE "SendStatus" AS ENUM ('SENT', 'FAILED');

CREATE TABLE "TeamAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SendStatus" NOT NULL,
    "text" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamAlert_key_key" ON "TeamAlert"("key");
CREATE INDEX "TeamAlert_createdAt_idx" ON "TeamAlert"("createdAt");

CREATE TABLE "RelationNotice" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "RelationKind" NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "SendStatus" NOT NULL,
    "variables" JSONB,
    "reason" TEXT,
    "conversationId" TEXT,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RelationNotice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RelationNotice_key_key" ON "RelationNotice"("key");
CREATE INDEX "RelationNotice_contactId_createdAt_idx" ON "RelationNotice"("contactId", "createdAt");

CREATE TABLE "SupplierSend" (
    "id" TEXT NOT NULL,
    "kind" "SupplierSendKind" NOT NULL,
    "status" "SendStatus" NOT NULL,
    "supplierBlingId" TEXT,
    "supplierName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "purchaseOrderNumber" INTEGER,
    "filename" TEXT,
    "reason" TEXT,
    "conversationId" TEXT,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierSend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SupplierSend_purchaseOrderId_idx" ON "SupplierSend"("purchaseOrderId");
CREATE INDEX "SupplierSend_createdAt_idx" ON "SupplierSend"("createdAt");

-- Produção: alertas do sistema no WhatsApp dos administradores
ALTER TYPE "AlertKind" ADD VALUE 'SISTEMA';
ALTER TABLE "User" ADD COLUMN "alertSystem" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Alert" ADD COLUMN "notifiedAt" TIMESTAMP(3);

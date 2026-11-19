-- Equipe: vários acessos ao painel (administrador / atendente), responsável pela conversa e autor da mensagem
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ATENDENTE');

ALTER TABLE "User" ADD COLUMN "name" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'ATENDENTE';
ALTER TABLE "User" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
-- quem já existia era o acesso único: vira administrador
UPDATE "User" SET "role" = 'ADMIN';

ALTER TABLE "Conversation" ADD COLUMN "assignedToId" TEXT;
CREATE INDEX "Conversation_assignedToId_idx" ON "Conversation"("assignedToId");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Message" ADD COLUMN "sentByUserId" TEXT;
ALTER TABLE "Message" ADD CONSTRAINT "Message_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

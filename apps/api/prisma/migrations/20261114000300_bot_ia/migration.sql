-- Etapa 5: bot de IA (simulador, base de conhecimento versionada, logs detalhados)
CREATE TABLE "BotSimSession" (
    "id" TEXT NOT NULL,
    "customerName" TEXT,
    "phone" TEXT NOT NULL,
    "document" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "summaryUpTo" INTEGER NOT NULL DEFAULT 0,
    "handedOff" BOOLEAN NOT NULL DEFAULT false,
    "handoffReason" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BotSimSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeVersion" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeVersion_createdAt_idx" ON "KnowledgeVersion"("createdAt");

ALTER TABLE "BotLog" ADD COLUMN "simSessionId" TEXT;
ALTER TABLE "BotLog" ADD COLUMN "inboundMessageId" TEXT;
ALTER TABLE "BotLog" ADD COLUMN "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BotLog" ADD COLUMN "iterations" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "BotLog" ADD COLUMN "stopReason" TEXT;
ALTER TABLE "BotLog" ADD COLUMN "handoff" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "BotLog_createdAt_idx" ON "BotLog"("createdAt");
CREATE INDEX "BotLog_simSessionId_createdAt_idx" ON "BotLog"("simSessionId", "createdAt");
ALTER TABLE "BotLog" ADD CONSTRAINT "BotLog_simSessionId_fkey" FOREIGN KEY ("simSessionId") REFERENCES "BotSimSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

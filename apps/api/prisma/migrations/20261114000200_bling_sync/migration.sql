-- Etapa 4: integração Bling (sync incremental de produtos + busca sem acento)
ALTER TABLE "BlingAuth" ADD COLUMN "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "BlingAuth" ADD COLUMN "lastRefreshAt" TIMESTAMP(3);

DROP INDEX IF EXISTS "Product_sku_key";
ALTER TABLE "Product" ADD COLUMN "parentBlingId" TEXT;
ALTER TABLE "Product" ADD COLUMN "format" TEXT;
ALTER TABLE "Product" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "Product" ADD COLUMN "searchText" TEXT;
ALTER TABLE "Product" ADD COLUMN "listHash" TEXT;
ALTER TABLE "Product" ADD COLUMN "detailSyncedAt" TIMESTAMP(3);

CREATE INDEX "Product_sku_idx" ON "Product"("sku");
CREATE INDEX "Product_active_idx" ON "Product"("active");
CREATE INDEX IF NOT EXISTS "Product_searchText_trgm_idx" ON "Product" USING GIN ("searchText" gin_trgm_ops);

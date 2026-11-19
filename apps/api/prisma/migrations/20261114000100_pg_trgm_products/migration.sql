-- Busca aproximada de produtos para o bot (buscar_produtos): pg_trgm + índices GIN.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_descriptionText_trgm_idx" ON "Product" USING GIN ("descriptionText" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Product_category_trgm_idx" ON "Product" USING GIN ("category" gin_trgm_ops);

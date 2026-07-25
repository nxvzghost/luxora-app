-- CreateTable
CREATE TABLE "tenant_api_key" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "hashed_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "tenant_api_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_api_key_tenant_id_key" ON "tenant_api_key"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_api_key_hashed_key_key" ON "tenant_api_key"("hashed_key");

-- AddForeignKey
ALTER TABLE "tenant_api_key" ADD CONSTRAINT "tenant_api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RLS (ver prisma/rls/enable-rls.sql, fonte de verdade) — padrão tenant_isolation + a exceção api_key_lookup_by_hash
ALTER TABLE "tenant_api_key" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_api_key" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant_api_key";
CREATE POLICY tenant_isolation ON "tenant_api_key" USING (tenant_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS api_key_lookup_by_hash ON "tenant_api_key";
CREATE POLICY api_key_lookup_by_hash ON "tenant_api_key"
  FOR SELECT
  USING (current_setting('app.bypass_tenant_check', true) = 'true');

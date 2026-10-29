CREATE TABLE "brand_profiles" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "displayName" TEXT, "primaryColor" TEXT, "secondaryColor" TEXT, "accentColor" TEXT, "fontFamily" TEXT, "websiteUrl" TEXT, "logoAssetId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "brand_profiles_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "branch_brand_overrides" (
  "id" TEXT NOT NULL, "branchId" TEXT NOT NULL, "displayName" TEXT, "primaryColor" TEXT, "secondaryColor" TEXT, "accentColor" TEXT, "fontFamily" TEXT, "websiteUrl" TEXT, "logoAssetId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "branch_brand_overrides_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "assets" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "branchId" TEXT, "uploadedById" TEXT NOT NULL, "originalName" TEXT NOT NULL, "storageKey" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "width" INTEGER, "height" INTEGER, "checksumSha256" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'ACTIVE', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL, "deletedAt" TIMESTAMP(3),
  CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "brand_profiles_organizationId_key" ON "brand_profiles"("organizationId");
CREATE UNIQUE INDEX "brand_profiles_logoAssetId_key" ON "brand_profiles"("logoAssetId");
CREATE UNIQUE INDEX "branch_brand_overrides_branchId_key" ON "branch_brand_overrides"("branchId");
CREATE UNIQUE INDEX "branch_brand_overrides_logoAssetId_key" ON "branch_brand_overrides"("logoAssetId");
CREATE UNIQUE INDEX "assets_storageKey_key" ON "assets"("storageKey");
CREATE INDEX "assets_organizationId_status_createdAt_idx" ON "assets"("organizationId", "status", "createdAt");
CREATE INDEX "assets_branchId_status_createdAt_idx" ON "assets"("branchId", "status", "createdAt");
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_brand_overrides" ADD CONSTRAINT "branch_brand_overrides_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "assets" ADD CONSTRAINT "assets_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "branch_brand_overrides" ADD CONSTRAINT "branch_brand_overrides_logoAssetId_fkey" FOREIGN KEY ("logoAssetId") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

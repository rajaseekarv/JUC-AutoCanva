-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currentRevisionId" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_revisions" (
    "id" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "summary" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "creatives_organizationId_branchId_updatedAt_idx" ON "creatives"("organizationId", "branchId", "updatedAt");

-- CreateIndex
CREATE INDEX "creatives_campaignId_branchId_idx" ON "creatives"("campaignId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "creatives_id_currentRevisionId_key" ON "creatives"("id", "currentRevisionId");

-- CreateIndex
CREATE INDEX "creative_revisions_templateVersionId_idx" ON "creative_revisions"("templateVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "creative_revisions_creativeId_revisionNumber_key" ON "creative_revisions"("creativeId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "creative_revisions_creativeId_id_key" ON "creative_revisions"("creativeId", "id");

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_id_currentRevisionId_fkey" FOREIGN KEY ("id", "currentRevisionId") REFERENCES "creative_revisions"("creativeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_revisions" ADD CONSTRAINT "creative_revisions_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_revisions" ADD CONSTRAINT "creative_revisions_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "template_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

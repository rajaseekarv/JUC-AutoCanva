CREATE TYPE "CanvaConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED');
CREATE TYPE "CanvaJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "canva_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "CanvaConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "mode" TEXT NOT NULL DEFAULT 'MOCK',
    "connectedById" TEXT,
    "connectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "canva_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "canva_jobs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "creativeRevisionId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "CanvaJobStatus" NOT NULL DEFAULT 'QUEUED',
    "mode" TEXT NOT NULL DEFAULT 'MOCK',
    "externalDesignId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "canva_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "canva_connections_organizationId_key" ON "canva_connections"("organizationId");
CREATE UNIQUE INDEX "canva_jobs_organizationId_idempotencyKey_key" ON "canva_jobs"("organizationId", "idempotencyKey");
CREATE INDEX "canva_jobs_organizationId_createdAt_idx" ON "canva_jobs"("organizationId", "createdAt");
CREATE INDEX "canva_jobs_organizationId_branchId_createdAt_idx" ON "canva_jobs"("organizationId", "branchId", "createdAt");
CREATE INDEX "canva_jobs_creativeId_creativeRevisionId_idx" ON "canva_jobs"("creativeId", "creativeRevisionId");

ALTER TABLE "canva_connections" ADD CONSTRAINT "canva_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "canva_jobs" ADD CONSTRAINT "canva_jobs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "canva_jobs" ADD CONSTRAINT "canva_jobs_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "canva_jobs" ADD CONSTRAINT "canva_jobs_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "canva_jobs" ADD CONSTRAINT "canva_jobs_creativeRevisionId_fkey" FOREIGN KEY ("creativeRevisionId") REFERENCES "creative_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "ReviewDecisionType" AS ENUM ('APPROVED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "ChangeRequestStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "workflow_stages" ADD COLUMN     "requiresReview" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "workflow_tasks" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedById" TEXT;

-- AlterTable
ALTER TABLE "workflow_transitions" ADD COLUMN     "reviewDecision" "ReviewDecisionType";

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "creativeRevisionId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "workflowTaskId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "ReviewDecisionType" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "creativeRevisionId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "workflowInstanceId" TEXT NOT NULL,
    "workflowTaskId" TEXT NOT NULL,
    "originatingDecisionId" TEXT,
    "requestedChanges" TEXT NOT NULL,
    "explanation" TEXT,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedById" TEXT,
    "startedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_comments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "creativeRevisionId" TEXT NOT NULL,
    "parentId" TEXT,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_decisions_organizationId_branchId_creativeId_creat_idx" ON "approval_decisions"("organizationId", "branchId", "creativeId", "createdAt");

-- CreateIndex
CREATE INDEX "approval_decisions_workflowInstanceId_createdAt_idx" ON "approval_decisions"("workflowInstanceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "approval_decisions_workflowTaskId_workflowInstanceId_key" ON "approval_decisions"("workflowTaskId", "workflowInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_originatingDecisionId_key" ON "change_requests"("originatingDecisionId");

-- CreateIndex
CREATE INDEX "change_requests_organizationId_branchId_creativeId_status_c_idx" ON "change_requests"("organizationId", "branchId", "creativeId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "change_requests_workflowInstanceId_workflowTaskId_idx" ON "change_requests"("workflowInstanceId", "workflowTaskId");

-- CreateIndex
CREATE INDEX "creative_comments_organizationId_branchId_creativeId_creati_idx" ON "creative_comments"("organizationId", "branchId", "creativeId", "creativeRevisionId", "createdAt");

-- CreateIndex
CREATE INDEX "creative_comments_parentId_createdAt_idx" ON "creative_comments"("parentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "creative_comments_id_creativeId_creativeRevisionId_key" ON "creative_comments"("id", "creativeId", "creativeRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_instances_id_creativeId_key" ON "workflow_instances"("id", "creativeId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_tasks_id_instanceId_key" ON "workflow_tasks"("id", "instanceId");

-- AddForeignKey
ALTER TABLE "workflow_tasks" ADD CONSTRAINT "workflow_tasks_completedById_fkey" FOREIGN KEY ("completedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_creativeId_creativeRevisionId_fkey" FOREIGN KEY ("creativeId", "creativeRevisionId") REFERENCES "creative_revisions"("creativeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_workflowInstanceId_creativeId_fkey" FOREIGN KEY ("workflowInstanceId", "creativeId") REFERENCES "workflow_instances"("id", "creativeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_workflowTaskId_workflowInstanceId_fkey" FOREIGN KEY ("workflowTaskId", "workflowInstanceId") REFERENCES "workflow_tasks"("id", "instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_creativeId_creativeRevisionId_fkey" FOREIGN KEY ("creativeId", "creativeRevisionId") REFERENCES "creative_revisions"("creativeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_workflowInstanceId_creativeId_fkey" FOREIGN KEY ("workflowInstanceId", "creativeId") REFERENCES "workflow_instances"("id", "creativeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_workflowTaskId_workflowInstanceId_fkey" FOREIGN KEY ("workflowTaskId", "workflowInstanceId") REFERENCES "workflow_tasks"("id", "instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_originatingDecisionId_fkey" FOREIGN KEY ("originatingDecisionId") REFERENCES "approval_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_comments" ADD CONSTRAINT "creative_comments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_comments" ADD CONSTRAINT "creative_comments_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_comments" ADD CONSTRAINT "creative_comments_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "creatives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_comments" ADD CONSTRAINT "creative_comments_creativeId_creativeRevisionId_fkey" FOREIGN KEY ("creativeId", "creativeRevisionId") REFERENCES "creative_revisions"("creativeId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_comments" ADD CONSTRAINT "creative_comments_parentId_creativeId_creativeRevisionId_fkey" FOREIGN KEY ("parentId", "creativeId", "creativeRevisionId") REFERENCES "creative_comments"("id", "creativeId", "creativeRevisionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_comments" ADD CONSTRAINT "creative_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

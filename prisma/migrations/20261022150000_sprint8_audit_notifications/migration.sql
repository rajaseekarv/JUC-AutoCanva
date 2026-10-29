CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "branchId" TEXT,
    "creativeId" TEXT,
    "creativeRevisionId" TEXT,
    "workflowInstanceId" TEXT,
    "changeRequestId" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "in_app_notifications" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "branchId" TEXT,
    "creativeId" TEXT,
    "creativeRevisionId" TEXT,
    "workflowInstanceId" TEXT,
    "changeRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),
    CONSTRAINT "in_app_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_organizationId_createdAt_id_idx" ON "audit_logs"("organizationId", "createdAt", "id");
CREATE INDEX "audit_logs_organizationId_branchId_createdAt_id_idx" ON "audit_logs"("organizationId", "branchId", "createdAt", "id");
CREATE INDEX "audit_logs_organizationId_actorUserId_createdAt_idx" ON "audit_logs"("organizationId", "actorUserId", "createdAt");
CREATE INDEX "audit_logs_organizationId_action_createdAt_idx" ON "audit_logs"("organizationId", "action", "createdAt");
CREATE INDEX "audit_logs_organizationId_entityType_entityId_createdAt_idx" ON "audit_logs"("organizationId", "entityType", "entityId", "createdAt");
CREATE UNIQUE INDEX "in_app_notifications_recipientUserId_eventKey_key" ON "in_app_notifications"("recipientUserId", "eventKey");
CREATE INDEX "in_app_notifications_recipientUserId_organizationId_createdAt_id_idx" ON "in_app_notifications"("recipientUserId", "organizationId", "createdAt", "id");
CREATE INDEX "in_app_notifications_recipientUserId_readAt_createdAt_idx" ON "in_app_notifications"("recipientUserId", "readAt", "createdAt");
CREATE INDEX "in_app_notifications_organizationId_branchId_createdAt_idx" ON "in_app_notifications"("organizationId", "branchId", "createdAt");

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "in_app_notifications" ADD CONSTRAINT "in_app_notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

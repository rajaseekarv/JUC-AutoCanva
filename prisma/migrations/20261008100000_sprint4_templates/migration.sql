CREATE TYPE "TemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "TemplateUnit" AS ENUM ('PX', 'MM', 'CM', 'IN');
CREATE TYPE "TemplateFieldType" AS ENUM ('TEXT', 'MULTILINE_TEXT', 'IMAGE', 'LOGO', 'PHONE', 'URL', 'DATE', 'NUMBER', 'BOOLEAN', 'COLOR');
CREATE TYPE "TemplateDataSource" AS ENUM ('ORGANIZATION_BRAND', 'EFFECTIVE_BRAND', 'BRANCH', 'CUSTOM');

CREATE TABLE "templates" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT,
  "status" "TemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "formatName" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "unit" "TemplateUnit" NOT NULL DEFAULT 'PX',
  "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
  "activeVersionNumber" INTEGER,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "template_versions" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "immutableAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "template_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "template_fields" (
  "id" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" "TemplateFieldType" NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "defaultValue" JSONB,
  "validationRules" JSONB,
  "helpText" TEXT,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "dataSource" "TemplateDataSource",
  "sourceKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "template_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "templates_organizationId_code_key" ON "templates"("organizationId", "code");
CREATE INDEX "templates_organizationId_status_updatedAt_idx" ON "templates"("organizationId", "status", "updatedAt");
CREATE UNIQUE INDEX "template_versions_templateId_versionNumber_key" ON "template_versions"("templateId", "versionNumber");
CREATE INDEX "template_versions_templateId_versionNumber_idx" ON "template_versions"("templateId", "versionNumber");
CREATE UNIQUE INDEX "template_fields_versionId_key_key" ON "template_fields"("versionId", "key");
CREATE INDEX "template_fields_versionId_displayOrder_idx" ON "template_fields"("versionId", "displayOrder");

ALTER TABLE "templates" ADD CONSTRAINT "templates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "template_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

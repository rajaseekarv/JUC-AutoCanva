ALTER TABLE "template_versions"
  ADD COLUMN "name" TEXT,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "formatName" TEXT,
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "unit" "TemplateUnit" NOT NULL DEFAULT 'PX';

UPDATE "template_versions" AS version
SET "name" = template."name",
    "description" = template."description",
    "category" = template."category",
    "formatName" = template."formatName",
    "width" = template."width",
    "height" = template."height"
FROM "templates" AS template
WHERE version."templateId" = template."id";

ALTER TABLE "template_versions"
  ALTER COLUMN "name" SET NOT NULL,
  ALTER COLUMN "formatName" SET NOT NULL,
  ALTER COLUMN "width" SET NOT NULL,
  ALTER COLUMN "height" SET NOT NULL;

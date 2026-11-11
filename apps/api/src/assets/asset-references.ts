import type { Prisma } from '@prisma/client';

type QueryClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

export type CreativeRevisionReference = {
  revisionId: string;
  revisionNumber: number;
  templateVersionId: string;
  creativeId: string;
  creativeName: string;
  branchId: string;
  branchName: string;
  isCurrentRevision: boolean;
  // Template field keys whose value is the asset ID.
  fieldKeys: string[];
};

// Every retained creative revision of the organization that references the
// asset. Revisions keep image and logo asset IDs as top-level string values
// of their JSON field map. This is the single definition of a creative
// reference: deletion and branch moves refuse while it returns anything, and
// the usage view lists what it returns.
export function findCreativeRevisionReferences(
  client: QueryClient,
  organizationId: string,
  assetId: string,
): Promise<CreativeRevisionReference[]> {
  return client.$queryRaw<CreativeRevisionReference[]>`
    SELECT
      r."id" AS "revisionId",
      r."revisionNumber",
      r."templateVersionId",
      c."id" AS "creativeId",
      c."name" AS "creativeName",
      c."branchId",
      b."name" AS "branchName",
      c."currentRevisionId" IS NOT DISTINCT FROM r."id" AS "isCurrentRevision",
      ARRAY(
        SELECT v.key
        FROM jsonb_each(
          CASE WHEN jsonb_typeof(r."values") = 'object'
            THEN r."values" ELSE '{}'::jsonb END
        ) v
        WHERE v.value = p.asset
        ORDER BY v.key
      ) AS "fieldKeys"
    FROM (
      SELECT ${organizationId}::text AS organization_id,
        to_jsonb(${assetId}::text) AS asset
    ) p
    JOIN "creatives" c ON c."organizationId" = p.organization_id
    JOIN "creative_revisions" r ON r."creativeId" = c."id"
    JOIN "branches" b ON b."id" = c."branchId"
    WHERE jsonb_path_exists(
      r."values",
      '$.* ? (@ == $asset)',
      jsonb_build_object('asset', p.asset)
    )
    ORDER BY c."name", c."id", r."revisionNumber" DESC
  `;
}

// The organization brand profile that uses the asset as its logo.
export function organizationLogoWhere(organizationId: string, assetId: string) {
  return { logoAssetId: assetId, organizationId };
}

// Branch brand overrides of the organization that use the asset as a logo.
export function branchLogoWhere(organizationId: string, assetId: string) {
  return { logoAssetId: assetId, branch: { organizationId } };
}

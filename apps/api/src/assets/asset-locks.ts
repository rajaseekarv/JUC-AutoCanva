import { Prisma } from '@prisma/client';

export const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];

type QueryClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

// Anything that stores a reference to an asset (a creative revision value or
// a brand logo) must call this inside the transaction that writes the
// reference, before that write. FOR SHARE conflicts with the FOR UPDATE that
// asset deletion and branch moves take, so either the deletion or move
// commits first and the asset is no longer returned here (it is gone or now
// out of scope; under SERIALIZABLE the transaction fails to serialize), or
// the reference commits first and the deletion or move then sees it.
// Shared locks do not conflict with each other, and IDs are locked in a
// fixed order, so concurrent writers cannot deadlock among themselves.
//
// Returns the IDs that are active image assets of the organization and
// either organization-wide or attached to `branchId` (organization-wide
// only when `branchId` is null). Callers reject any ID missing from it.
export async function lockActiveAssetsForReference(
  tx: QueryClient,
  organizationId: string,
  branchId: string | null,
  assetIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(assetIds)].sort();
  if (ids.length === 0) return new Set();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "assets"
    WHERE "id" IN (${Prisma.join(ids)})
      AND "organizationId" = ${organizationId}
      AND "status" = 'ACTIVE'
      AND "mimeType" IN (${Prisma.join(imageMimeTypes)})
      AND ("branchId" IS NULL OR "branchId" = ${branchId})
    ORDER BY "id"
    FOR SHARE
  `;
  return new Set(rows.map((row) => row.id));
}

// Taken by asset deletion and by branch moves before they look for
// references; see above. Returns the locked row's current branch, or null
// when the asset is no longer active in the organization. Each caller locks
// a single asset, so it cannot form a lock cycle with the ordered shared
// locks of reference writers.
export async function lockActiveAssetForChange(
  tx: QueryClient,
  organizationId: string,
  assetId: string,
): Promise<{ branchId: string | null } | null> {
  const [row] = await tx.$queryRaw<Array<{ branchId: string | null }>>`
    SELECT "branchId"
    FROM "assets"
    WHERE "id" = ${assetId}
      AND "organizationId" = ${organizationId}
      AND "status" = 'ACTIVE'
    FOR UPDATE
  `;
  return row ?? null;
}

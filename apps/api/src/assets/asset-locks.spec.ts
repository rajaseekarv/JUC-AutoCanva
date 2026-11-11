import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  lockActiveAssetForChange,
  lockActiveAssetsForReference,
} from './asset-locks';

// Renders the tagged-template call the helper made into SQL text and its
// flattened parameter list, the same way Prisma would send it.
function rendered(queryRaw: ReturnType<typeof vi.fn>) {
  const [strings, ...values] = queryRaw.mock.calls[0] as [
    TemplateStringsArray,
    ...unknown[],
  ];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.sql, values: sql.values };
}

describe('lockActiveAssetsForReference', () => {
  it('takes shared locks on in-scope active images, in a fixed ID order', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ id: 'asset-a' }]);
    const locked = await lockActiveAssetsForReference(
      { $queryRaw: queryRaw } as never,
      'org-1',
      'branch-1',
      ['asset-c', 'asset-a', 'asset-c'],
    );
    expect(locked).toEqual(new Set(['asset-a']));
    const { text, values } = rendered(queryRaw);
    expect(text).toMatch(/ORDER BY "id"\s+FOR SHARE\s*$/);
    expect(text).toContain('"status" = \'ACTIVE\'');
    expect(text).toContain('("branchId" IS NULL OR "branchId" = ?)');
    // Deduplicated and sorted IDs, then the organization, image types and
    // branch scope.
    expect(values).toEqual([
      'asset-a',
      'asset-c',
      'org-1',
      'image/png',
      'image/jpeg',
      'image/webp',
      'branch-1',
    ]);
  });

  it('limits organization-scope references to organization-wide assets', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await lockActiveAssetsForReference(
      { $queryRaw: queryRaw } as never,
      'org-1',
      null,
      ['asset-a'],
    );
    // `"branchId" = NULL` is never true, so only NULL-branch assets match.
    expect(rendered(queryRaw).values.at(-1)).toBeNull();
  });

  it('issues no query when nothing is referenced', async () => {
    const queryRaw = vi.fn();
    await expect(
      lockActiveAssetsForReference(
        { $queryRaw: queryRaw } as never,
        'org-1',
        'branch-1',
        [],
      ),
    ).resolves.toEqual(new Set());
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('lockActiveAssetForChange', () => {
  it('takes an exclusive lock on the active asset and returns its current branch', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]);
    await expect(
      lockActiveAssetForChange(
        { $queryRaw: queryRaw } as never,
        'org-1',
        'asset-1',
      ),
    ).resolves.toEqual({ branchId: 'branch-1' });
    const { text, values } = rendered(queryRaw);
    expect(text).toMatch(/SELECT "branchId"\s+FROM "assets"/);
    expect(text).toMatch(/"status" = 'ACTIVE'\s+FOR UPDATE\s*$/);
    expect(values).toEqual(['asset-1', 'org-1']);
  });

  it('reports null when the asset is no longer active', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await expect(
      lockActiveAssetForChange(
        { $queryRaw: queryRaw } as never,
        'org-1',
        'asset-1',
      ),
    ).resolves.toBeNull();
  });
});

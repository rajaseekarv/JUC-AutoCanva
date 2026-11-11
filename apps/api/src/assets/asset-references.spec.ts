import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  branchLogoWhere,
  findCreativeRevisionReferences,
  organizationLogoWhere,
} from './asset-references';

describe('findCreativeRevisionReferences', () => {
  it('scopes to the organization, matches top-level values, and only reads', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await findCreativeRevisionReferences(
      { $queryRaw: queryRaw } as never,
      'org-1',
      'asset-1',
    );
    const [strings, ...values] = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = Prisma.sql(strings, ...values);
    expect(sql.values).toEqual(['org-1', 'asset-1']);
    const text = sql.sql.replace(/\s+/g, ' ');
    expect(text).toContain(
      'JOIN "creatives" c ON c."organizationId" = p.organization_id',
    );
    expect(text).toContain(
      'JOIN "creative_revisions" r ON r."creativeId" = c."id"',
    );
    // The same predicate the earlier deletion check used.
    expect(text).toContain(
      `jsonb_path_exists( r."values", '$.* ? (@ == $asset)', jsonb_build_object('asset', p.asset) )`,
    );
    expect(text).not.toMatch(/FOR (UPDATE|SHARE)|INSERT|UPDATE "|DELETE/i);
  });
});

describe('brand logo reference filters', () => {
  it('limit organization and branch logos to the organization', () => {
    expect(organizationLogoWhere('org-1', 'asset-1')).toEqual({
      logoAssetId: 'asset-1',
      organizationId: 'org-1',
    });
    expect(branchLogoWhere('org-1', 'asset-1')).toEqual({
      logoAssetId: 'asset-1',
      branch: { organizationId: 'org-1' },
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import { BrandService } from './brand.service';

const user: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  email: 'admin@example.local',
  name: 'Admin',
  permissions: [PERMISSIONS.BRAND_READ, PERMISSIONS.BRANCH_MANAGE],
  branches: [],
};

describe('BrandService', () => {
  it('combines organization defaults with branch overrides', async () => {
    const prisma = {
      branch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
      brandProfile: {
        findUnique: vi.fn().mockResolvedValue({
          displayName: 'Acme',
          primaryColor: '#112233',
          secondaryColor: null,
          accentColor: '#445566',
          fontFamily: 'Inter',
          websiteUrl: null,
          logoAssetId: null,
        }),
      },
      branchBrandOverride: {
        findUnique: vi.fn().mockResolvedValue({
          displayName: null,
          primaryColor: '#abcdef',
          secondaryColor: null,
          accentColor: null,
          fontFamily: null,
          websiteUrl: null,
          logoAssetId: null,
        }),
      },
    };
    const result = await new BrandService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    ).effective(user, 'branch-1');
    expect(result).toMatchObject({
      displayName: 'Acme',
      primaryColor: '#abcdef',
      accentColor: '#445566',
      overriddenFields: ['primaryColor'],
    });
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'branch-1', organizationId: 'org-1' },
      }),
    );
  });

  it('does not let branch brand management grant organization-wide management', async () => {
    const branchManager = {
      ...user,
      permissions: [PERMISSIONS.BRAND_MANAGE, PERMISSIONS.BRANCH_MANAGE],
    };
    const prisma = { brandProfile: { upsert: vi.fn() } };
    await expect(
      new BrandService(
        prisma as unknown as PrismaService,
        { write: vi.fn().mockResolvedValue({}) } as never,
      ).updateOrganization(branchManager, { displayName: 'Changed' }),
    ).rejects.toThrow('Permission denied');
    expect(prisma.brandProfile.upsert).not.toHaveBeenCalled();
  });
  it('rejects branch IDs outside the caller organization', async () => {
    const prisma = {
      branch: { findFirst: vi.fn().mockResolvedValue(null) },
      userBranchAccess: { findFirst: vi.fn() },
    };
    await expect(
      new BrandService(
        prisma as unknown as PrismaService,
        { write: vi.fn().mockResolvedValue({}) } as never,
      ).effective(user, 'foreign-branch'),
    ).rejects.toThrow('Branch not found');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import { BrandService } from './brand.service';
import { transactionConflictMessage } from '../prisma/transaction-errors';

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

  describe('logo asset locking', () => {
    const manager: AuthenticatedPrincipal = {
      ...user,
      permissions: [
        PERMISSIONS.BRAND_MANAGE,
        PERMISSIONS.BRANCH_MANAGE,
        PERMISSIONS.ORGANIZATION_UPDATE,
      ],
    };

    function setup(lockedIds: string[]) {
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue(lockedIds.map((id) => ({ id }))),
        brandProfile: {
          upsert: vi.fn().mockResolvedValue({ id: 'profile-1' }),
        },
        branchBrandOverride: {
          upsert: vi.fn().mockResolvedValue({ id: 'override-1' }),
        },
      };
      const prisma = {
        branch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
        $transaction: vi.fn((callback: (client: unknown) => unknown) =>
          callback(tx),
        ),
      };
      const audit = { write: vi.fn().mockResolvedValue({}) };
      const service = new BrandService(
        prisma as unknown as PrismaService,
        audit as never,
      );
      return { service, tx, audit, prisma };
    }
    const lockCall = (tx: { $queryRaw: ReturnType<typeof vi.fn> }) => {
      const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      return Prisma.sql(strings, ...values);
    };

    it('share-locks an organization logo inside the write transaction, before the upsert', async () => {
      const { service, tx } = setup(['asset-1']);
      await service.updateOrganization(manager, { logoAssetId: 'asset-1' });
      const lock = lockCall(tx);
      expect(lock.sql).toMatch(/FOR SHARE\s*$/);
      // Organization logos must be organization-wide assets (null scope).
      expect(lock.values).toEqual(expect.arrayContaining(['asset-1', 'org-1']));
      expect(lock.values.at(-1)).toBeNull();
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.brandProfile.upsert.mock.invocationCallOrder[0] ?? -Infinity,
      );
    });

    it('rejects an organization logo that is no longer an active in-scope asset', async () => {
      const { service, tx, audit } = setup([]);
      await expect(
        service.updateOrganization(manager, { logoAssetId: 'asset-1' }),
      ).rejects.toThrow('Asset not found');
      expect(tx.brandProfile.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('share-locks a branch logo with the branch scope, before the upsert', async () => {
      const { service, tx } = setup(['asset-2']);
      await service.updateBranch(manager, 'branch-1', {
        logoAssetId: 'asset-2',
      });
      expect(lockCall(tx).values.at(-1)).toBe('branch-1');
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.branchBrandOverride.upsert.mock.invocationCallOrder[0] ?? -Infinity,
      );
    });

    it('rejects a branch logo deleted concurrently, without writing', async () => {
      const { service, tx } = setup([]);
      await expect(
        service.updateBranch(manager, 'branch-1', { logoAssetId: 'asset-2' }),
      ).rejects.toThrow('Asset not found');
      expect(tx.branchBrandOverride.upsert).not.toHaveBeenCalled();
    });

    it('takes no lock when the logo is cleared or unchanged', async () => {
      const { service, tx } = setup([]);
      await service.updateOrganization(manager, { logoAssetId: null });
      await service.updateBranch(manager, 'branch-1', { displayName: 'North' });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.brandProfile.upsert).toHaveBeenCalled();
      expect(tx.branchBrandOverride.upsert).toHaveBeenCalled();
    });

    it('answers 409 when PostgreSQL rolls a logo update back', async () => {
      const { service, prisma } = setup(['asset-1']);
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Raw query failed', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { code: '40001', message: 'could not serialize access' },
        }),
      );
      await expect(
        service.updateOrganization(manager, { logoAssetId: 'asset-1' }),
      ).rejects.toThrow(transactionConflictMessage);
    });
  });
});

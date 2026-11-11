import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from './assets.service';
import { transactionConflictMessage } from '../prisma/transaction-errors';
import type { AssetStorage } from './asset-storage';

const manager: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  email: 'admin@example.local',
  name: 'Admin',
  permissions: [
    PERMISSIONS.ASSET_MANAGE,
    PERMISSIONS.ASSET_READ,
    PERMISSIONS.BRANCH_MANAGE,
    PERMISSIONS.ORGANIZATION_UPDATE,
  ],
  branches: [],
};

describe('AssetsService', () => {
  it('rejects inactive, cross-organization, or out-of-branch image references for creatives', async () => {
    const prisma = {
      asset: { findFirst: vi.fn().mockResolvedValue(null) },
      branch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
    };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      {} as AssetStorage,
    );
    await expect(
      service.assertCreativeAsset(manager, 'asset-foreign', 'branch-1'),
    ).rejects.toThrow('in-scope active image asset');
    expect(prisma.asset.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'asset-foreign',
        organizationId: 'org-1',
        status: 'ACTIVE',
        mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
        OR: [{ branchId: null }, { branchId: 'branch-1' }],
      }),
      select: { id: true },
    });
  });

  it('rejects a file whose declared MIME type does not match a supported image', async () => {
    const prisma = { asset: { create: vi.fn() } };
    const storage = { put: vi.fn(), remove: vi.fn() };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      storage as unknown as AssetStorage,
    );
    await expect(
      service.upload(manager, {
        buffer: Buffer.from('not an image'),
        originalname: 'file.png',
        mimetype: 'image/png',
        size: 12,
      }),
    ).rejects.toThrow('Only valid PNG, JPEG, or WebP images are allowed');
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('blocks a user from reading an asset attached to another branch', async () => {
    const restricted = { ...manager, permissions: [PERMISSIONS.ASSET_READ] };
    const foreignAsset = {
      id: 'asset-foreign',
      organizationId: 'org-1',
      branchId: 'branch-other',
      uploadedById: 'user-2',
      originalName: 'brand.png',
      storageKey: 'generated.png',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 1,
      height: 1,
      checksumSha256: 'hash',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    const prisma = {
      asset: { findFirst: vi.fn().mockResolvedValue(foreignAsset) },
      userBranchAccess: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { get: vi.fn() } as unknown as AssetStorage,
    );
    await expect(service.get(restricted, 'asset-foreign')).rejects.toThrow(
      'Branch access denied',
    );
    expect(prisma.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1' }),
      }),
    );
  });

  it('keeps deleted assets out of active asset lists', async () => {
    const prisma = { asset: { findMany: vi.fn().mockResolvedValue([]) } };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      {} as AssetStorage,
    );
    await expect(service.list(manager)).resolves.toEqual([]);
    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'ACTIVE',
          organizationId: 'org-1',
        }),
      }),
    );
  });

  it('rejects uploads larger than the configured limit', async () => {
    const storage = { put: vi.fn() };
    const service = new AssetsService(
      {} as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      storage as unknown as AssetStorage,
    );
    const file = {
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
      originalname: 'large.png',
      mimetype: 'image/png',
      size: 5 * 1024 * 1024 + 1,
    };
    await expect(service.upload(manager, file)).rejects.toThrow(
      '5 MB or smaller',
    );
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('requires the asset-management permission for uploads', async () => {
    const readOnly = { ...manager, permissions: [PERMISSIONS.ASSET_READ] };
    const service = new AssetsService(
      {} as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      {} as AssetStorage,
    );
    await expect(service.upload(readOnly, undefined)).rejects.toThrow(
      'Permission denied',
    );
  });
  it('stores a valid PNG with a generated storage key and sanitized display name', async () => {
    const image = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
    image.writeUInt32BE(13, 8);
    image.write('IHDR', 12, 'ascii');
    image.writeUInt32BE(2, 16);
    image.writeUInt32BE(3, 20);
    const assetModel = {
      create: vi.fn().mockImplementation(async ({ data, select }) => ({
        id: 'asset-1',
        ...select,
        ...data,
      })),
    };
    const prisma = {
      asset: assetModel,
      $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
        callback({ asset: assetModel, auditLog: { create: vi.fn() } }),
      ),
    };
    const storage = {
      put: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      storage as unknown as AssetStorage,
    );
    await service.upload(manager, {
      buffer: image,
      originalname: '..\\secret.png',
      mimetype: 'image/png',
      size: image.length,
    });
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]+\.png$/),
      image,
    );
    expect(prisma.asset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originalName: 'secret.png',
          width: 2,
          height: 3,
        }),
      }),
    );
  });

  it.each([
    [
      'bytes after the signature that are not an IHDR chunk',
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        Buffer.from('this is not really an image'),
      ]),
    ],
    [
      'an IHDR chunk with a zero width',
      (() => {
        const header = Buffer.alloc(24);
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
        header.write('IHDR', 12, 'ascii');
        header.writeUInt32BE(0, 16);
        header.writeUInt32BE(3, 20);
        return header;
      })(),
    ],
  ])('records unknown dimensions for a PNG with %s', async (_case, image) => {
    const assetModel = {
      create: vi.fn().mockImplementation(async ({ data }) => ({
        id: 'asset-1',
        ...data,
      })),
    };
    const prisma = {
      asset: assetModel,
      $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
        callback({ asset: assetModel, auditLog: { create: vi.fn() } }),
      ),
    };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      {
        put: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn(),
      } as unknown as AssetStorage,
    );
    await service.upload(manager, {
      buffer: image,
      originalname: 'corrupt.png',
      mimetype: 'image/png',
      size: image.length,
    });
    expect(assetModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ width: null, height: null }),
      }),
    );
  });
});

describe('AssetsService content', () => {
  const reader = { ...manager, permissions: [PERMISSIONS.ASSET_READ] };
  const storedAsset = {
    id: 'asset-1',
    organizationId: 'org-1',
    branchId: null,
    uploadedById: 'user-1',
    originalName: 'logo.png',
    storageKey: 'generated.png',
    mimeType: 'image/png',
    sizeBytes: 10,
    width: 1,
    height: 1,
    checksumSha256: 'hash',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  function serviceWith(found: unknown, get: ReturnType<typeof vi.fn>) {
    const prisma = { asset: { findFirst: vi.fn().mockResolvedValue(found) } };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      { write: vi.fn() } as never,
      { get } as unknown as AssetStorage,
    );
    return { service, prisma };
  }

  it('reports a missing stored file as not found without exposing the path', async () => {
    const missing = Object.assign(
      new Error(
        "ENOENT: no such file or directory, open '/storage/generated.png'",
      ),
      { code: 'ENOENT' },
    );
    const { service } = serviceWith(
      storedAsset,
      vi.fn().mockRejectedValue(missing),
    );
    const result = service.content(reader, 'asset-1');
    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    await expect(result).rejects.toThrow('Asset content not found');
  });

  it('does not report other storage failures as missing content', async () => {
    const failure = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    const { service } = serviceWith(
      storedAsset,
      vi.fn().mockRejectedValue(failure),
    );
    await expect(service.content(reader, 'asset-1')).rejects.toBe(failure);
  });

  it('keeps reporting a deleted asset as not found without opening storage', async () => {
    const get = vi.fn();
    const { service, prisma } = serviceWith(null, get);
    await expect(service.content(reader, 'asset-1')).rejects.toThrow(
      'Asset not found',
    );
    expect(prisma.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe('AssetsService remove and branch move', () => {
  const storedAsset = {
    id: 'asset-1',
    organizationId: 'org-1',
    branchId: null as string | null,
    uploadedById: 'user-1',
    originalName: 'logo.png',
    storageKey: 'generated.png',
    mimeType: 'image/png',
    sizeBytes: 10,
    width: 1,
    height: 1,
    checksumSha256: 'hash',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  // References as stored, each tagged with the organization it belongs to.
  // The fakes apply the same filters as the real queries: the caller's
  // organization, and the asset ID as a top-level revision value or as the
  // logo of a brand profile or branch override.
  type References = {
    revisions?: Array<{
      id: string;
      organizationId: string;
      values: Record<string, unknown>;
    }>;
    organizationLogos?: Array<{ organizationId: string; logoAssetId: string }>;
    branchLogos?: Array<{ organizationId: string; logoAssetId: string }>;
    // False when a concurrent deletion already won the row lock.
    lockable?: boolean;
    // The branch the row lock finds; differs from the stored asset when a
    // concurrent move committed after authorization.
    lockedBranchId?: string | null;
    // Overrides for the asset found by authorization.
    asset?: Partial<typeof storedAsset>;
  };

  function serviceWith(references: References = {}) {
    const found = { ...storedAsset, ...references.asset };
    const queryRaw = vi.fn(
      async (sql: TemplateStringsArray, ...parameters: unknown[]) => {
        const text = sql.join('?');
        if (text.includes('FOR UPDATE'))
          return references.lockable === false
            ? []
            : [
                {
                  branchId:
                    references.lockedBranchId === undefined
                      ? found.branchId
                      : references.lockedBranchId,
                },
              ];
        const [organizationId, assetId] = parameters;
        return (references.revisions ?? [])
          .filter(
            (revision) =>
              revision.organizationId === organizationId &&
              Object.values(revision.values).includes(assetId),
          )
          .slice(0, 1)
          .map((revision) => ({ id: revision.id }));
      },
    );
    const logoLookup =
      (
        logos: References['organizationLogos'],
        organizationOf: (where: Record<string, unknown>) => unknown,
      ) =>
      async ({ where }: { where: Record<string, unknown> }) =>
        (logos ?? []).some(
          (logo) =>
            logo.logoAssetId === where.logoAssetId &&
            logo.organizationId === organizationOf(where),
        )
          ? { id: 'profile' }
          : null;
    const tx = {
      $queryRaw: queryRaw,
      brandProfile: {
        findFirst: vi.fn(
          logoLookup(
            references.organizationLogos,
            (where) => where.organizationId,
          ),
        ),
      },
      branchBrandOverride: {
        findFirst: vi.fn(
          logoLookup(
            references.branchLogos,
            (where) =>
              (where.branch as { organizationId: string }).organizationId,
          ),
        ),
      },
      asset: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...found,
          ...data,
        })),
      },
    };
    const prisma = {
      asset: { findFirst: vi.fn().mockResolvedValue(found) },
      branch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-2' }) },
      $transaction: vi.fn((callback: (client: unknown) => unknown) =>
        callback(tx),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const storage = { remove: vi.fn().mockResolvedValue(undefined) };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      audit as never,
      storage as unknown as AssetStorage,
    );
    return { service, prisma, tx, audit, storage, queryRaw };
  }

  function expectNothingWritten(context: ReturnType<typeof serviceWith>) {
    expect(context.tx.asset.update).not.toHaveBeenCalled();
    expect(context.audit.write).not.toHaveBeenCalled();
    expect(context.storage.remove).not.toHaveBeenCalled();
  }

  it('refuses with 409 while a retained creative revision references the asset', async () => {
    const context = serviceWith({
      revisions: [
        {
          id: 'revision-1',
          organizationId: 'org-1',
          values: { logo: 'asset-1' },
        },
      ],
    });
    const result = context.service.remove(manager, 'asset-1');
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toThrow(
      'Asset is used by a creative revision and cannot be deleted',
    );
    expectNothingWritten(context);
  });

  it('refuses with 409 while the organization brand profile uses it as its logo', async () => {
    const context = serviceWith({
      organizationLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
    });
    const result = context.service.remove(manager, 'asset-1');
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toThrow(
      'Asset is used as the organization brand logo and cannot be deleted',
    );
    expect(context.tx.brandProfile.findFirst).toHaveBeenCalledWith({
      where: { logoAssetId: 'asset-1', organizationId: 'org-1' },
      select: { id: true },
    });
    expectNothingWritten(context);
  });

  it('refuses with 409 while a branch brand override uses it as its logo', async () => {
    const context = serviceWith({
      branchLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
    });
    const result = context.service.remove(manager, 'asset-1');
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toThrow(
      'Asset is used as a branch brand logo and cannot be deleted',
    );
    expect(context.tx.branchBrandOverride.findFirst).toHaveBeenCalledWith({
      where: { logoAssetId: 'asset-1', branch: { organizationId: 'org-1' } },
      select: { id: true },
    });
    expectNothingWritten(context);
  });

  it('deletes an unreferenced asset without touching brand profiles', async () => {
    const { service, tx, audit, storage } = serviceWith({
      revisions: [
        {
          id: 'revision-1',
          organizationId: 'org-1',
          values: { logo: 'asset-2', headline: 'Sale' },
        },
      ],
      organizationLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-2' }],
    });
    await expect(service.remove(manager, 'asset-1')).resolves.toEqual({
      id: 'asset-1',
      status: 'DELETED',
    });
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'asset-1' },
      data: { status: 'DELETED', deletedAt: expect.any(Date) },
    });
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'asset.deleted', entityId: 'asset-1' }),
    );
    expect(storage.remove).toHaveBeenCalledWith('generated.png');
  });

  it('only counts references that belong to the caller organization', async () => {
    const { service, queryRaw, tx, storage } = serviceWith({
      revisions: [
        {
          id: 'revision-x',
          organizationId: 'org-2',
          values: { logo: 'asset-1' },
        },
      ],
      organizationLogos: [{ organizationId: 'org-2', logoAssetId: 'asset-1' }],
      branchLogos: [{ organizationId: 'org-2', logoAssetId: 'asset-1' }],
    });
    await expect(service.remove(manager, 'asset-1')).resolves.toEqual({
      id: 'asset-1',
      status: 'DELETED',
    });
    const [sql, ...parameters] = queryRaw.mock.calls[1] ?? [];
    expect(parameters).toEqual(['org-1', 'asset-1']);
    const text = (sql as TemplateStringsArray).join('?');
    expect(text).toContain('SELECT ?::text AS organization_id');
    expect(text).toContain(
      'JOIN "creatives" c ON c."organizationId" = p.organization_id',
    );
    expect(tx.asset.update).toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith('generated.png');
  });

  it('locks the active asset row before checking references or writing', async () => {
    const { service, prisma, queryRaw, tx } = serviceWith();
    await service.remove(manager, 'asset-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const [lockSql, ...lockParameters] = queryRaw.mock.calls[0] ?? [];
    const lockText = (lockSql as TemplateStringsArray).join('?');
    expect(lockText).toMatch(/"status" = 'ACTIVE'\s+FOR UPDATE/);
    expect(lockText).toContain('"organizationId" = ?');
    expect(lockParameters).toEqual(['asset-1', 'org-1']);
    const lockOrder = queryRaw.mock.invocationCallOrder[0] ?? Infinity;
    expect(lockOrder).toBeLessThan(
      queryRaw.mock.invocationCallOrder[1] ?? -Infinity,
    );
    expect(lockOrder).toBeLessThan(
      tx.brandProfile.findFirst.mock.invocationCallOrder[0] ?? -Infinity,
    );
    expect(lockOrder).toBeLessThan(
      tx.asset.update.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });

  it('reports 404 without writes when a concurrent deletion already holds or finished the lock', async () => {
    const context = serviceWith({ lockable: false });
    await expect(
      context.service.remove(manager, 'asset-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(context.queryRaw).toHaveBeenCalledTimes(1);
    expect(context.tx.brandProfile.findFirst).not.toHaveBeenCalled();
    expectNothingWritten(context);
  });

  it('reports an asset from another organization as not found before locking', async () => {
    const { service, prisma, queryRaw, storage } = serviceWith();
    prisma.asset.findFirst.mockResolvedValue(null);
    await expect(service.remove(manager, 'asset-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.asset.findFirst).toHaveBeenCalledWith({
      where: { id: 'asset-1', organizationId: 'org-1', status: 'ACTIVE' },
    });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('answers 409 without removing the file when PostgreSQL rolls the deletion back', async () => {
    const { service, prisma, storage } = serviceWith();
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Raw query failed', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '40P01', message: 'deadlock detected' },
      }),
    );
    await expect(service.remove(manager, 'asset-1')).rejects.toThrow(
      transactionConflictMessage,
    );
    expect(storage.remove).not.toHaveBeenCalled();
  });

  describe('branch move', () => {
    const branchAsset = { branchId: 'branch-1' };
    const moveTo = (
      context: ReturnType<typeof serviceWith>,
      branchId: string | null,
      principal: AuthenticatedPrincipal = manager,
    ) =>
      context.service
        .update(principal, 'asset-1', { branchId })
        .catch((error: unknown) => error);
    const expectUnchanged = (context: ReturnType<typeof serviceWith>) => {
      expect(context.tx.asset.update).not.toHaveBeenCalled();
      expect(context.audit.write).not.toHaveBeenCalled();
      expect(context.storage.remove).not.toHaveBeenCalled();
    };
    const expectInUse = (error: unknown, reason: string, message: string) => {
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        reason,
        message,
      });
    };

    it('refuses with 409 while a creative revision references the asset', async () => {
      const context = serviceWith({
        asset: branchAsset,
        revisions: [
          {
            id: 'revision-1',
            organizationId: 'org-1',
            values: { logo: 'asset-1' },
          },
        ],
      });
      expectInUse(
        await moveTo(context, 'branch-2'),
        'CREATIVE_REVISION',
        'Asset is used by a creative revision and cannot be moved to another branch',
      );
      expectUnchanged(context);
    });

    it('refuses with 409 while it is the organization brand logo', async () => {
      // Organization logos are organization-wide assets; moving one into a
      // branch would leave the profile pointing at an out-of-scope logo.
      const context = serviceWith({
        organizationLogos: [
          { organizationId: 'org-1', logoAssetId: 'asset-1' },
        ],
      });
      expectInUse(
        await moveTo(context, 'branch-2'),
        'ORGANIZATION_BRAND_LOGO',
        'Asset is used as the organization brand logo and cannot be moved to another branch',
      );
      expectUnchanged(context);
    });

    it('refuses with 409 while it is a branch brand logo', async () => {
      const context = serviceWith({
        asset: branchAsset,
        branchLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
      });
      expectInUse(
        await moveTo(context, 'branch-2'),
        'BRANCH_BRAND_LOGO',
        'Asset is used as a branch brand logo and cannot be moved to another branch',
      );
      expectUnchanged(context);
    });

    it('refuses a referenced move into organization scope as well', async () => {
      const context = serviceWith({
        asset: branchAsset,
        revisions: [
          {
            id: 'revision-1',
            organizationId: 'org-1',
            values: { hero: 'asset-1' },
          },
        ],
      });
      expectInUse(
        await moveTo(context, null),
        'CREATIVE_REVISION',
        'Asset is used by a creative revision and cannot be moved to another branch',
      );
      expectUnchanged(context);
    });

    it('moves an unreferenced asset and audits it', async () => {
      const context = serviceWith({
        asset: branchAsset,
        revisions: [
          {
            id: 'revision-1',
            organizationId: 'org-1',
            values: { logo: 'asset-2' },
          },
        ],
      });
      await expect(
        context.service.update(manager, 'asset-1', { branchId: 'branch-2' }),
      ).resolves.toMatchObject({ id: 'asset-1', branchId: 'branch-2' });
      expect(context.tx.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'asset-1' },
          data: { branchId: 'branch-2' },
        }),
      );
      expect(context.audit.write).toHaveBeenCalledWith(
        context.tx,
        expect.objectContaining({
          action: 'asset.updated',
          entityId: 'asset-1',
          branchId: 'branch-2',
        }),
      );
    });

    it('ignores references and logos from another organization', async () => {
      const context = serviceWith({
        asset: branchAsset,
        revisions: [
          {
            id: 'revision-x',
            organizationId: 'org-2',
            values: { logo: 'asset-1' },
          },
        ],
        organizationLogos: [
          { organizationId: 'org-2', logoAssetId: 'asset-1' },
        ],
        branchLogos: [{ organizationId: 'org-2', logoAssetId: 'asset-1' }],
      });
      await context.service.update(manager, 'asset-1', {
        branchId: 'branch-2',
      });
      expect(context.tx.asset.update).toHaveBeenCalled();
      expect(context.queryRaw.mock.calls[1]?.slice(1)).toEqual([
        'org-1',
        'asset-1',
      ]);
      expect(context.tx.brandProfile.findFirst).toHaveBeenCalledWith({
        where: { logoAssetId: 'asset-1', organizationId: 'org-1' },
        select: { id: true },
      });
      expect(context.tx.branchBrandOverride.findFirst).toHaveBeenCalledWith({
        where: { logoAssetId: 'asset-1', branch: { organizationId: 'org-1' } },
        select: { id: true },
      });
    });

    it('locks the row before checking references or writing', async () => {
      const context = serviceWith({ asset: branchAsset });
      await context.service.update(manager, 'asset-1', {
        branchId: 'branch-2',
      });
      const [lockSql, ...lockParameters] = context.queryRaw.mock.calls[0] ?? [];
      expect((lockSql as TemplateStringsArray).join('?')).toMatch(
        /"status" = 'ACTIVE'\s+FOR UPDATE/,
      );
      expect(lockParameters).toEqual(['asset-1', 'org-1']);
      const lockOrder =
        context.queryRaw.mock.invocationCallOrder[0] ?? Infinity;
      expect(lockOrder).toBeLessThan(
        context.queryRaw.mock.invocationCallOrder[1] ?? -Infinity,
      );
      expect(lockOrder).toBeLessThan(
        context.tx.asset.update.mock.invocationCallOrder[0] ?? -Infinity,
      );
    });

    it('refuses with a retryable 409 when a concurrent move changed the branch after authorization', async () => {
      const context = serviceWith({
        asset: branchAsset,
        lockedBranchId: 'branch-3',
      });
      const error = await moveTo(context, 'branch-2');
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe(transactionConflictMessage);
      expect(context.tx.brandProfile.findFirst).not.toHaveBeenCalled();
      expectUnchanged(context);
    });

    it('reports 404 when the asset was deleted before the lock', async () => {
      const context = serviceWith({ asset: branchAsset, lockable: false });
      expect(await moveTo(context, 'branch-2')).toBeInstanceOf(
        NotFoundException,
      );
      expectUnchanged(context);
    });

    it('renames without locking, checking references, or rewriting the branch', async () => {
      const context = serviceWith({
        asset: branchAsset,
        revisions: [
          {
            id: 'revision-1',
            organizationId: 'org-1',
            values: { logo: 'asset-1' },
          },
        ],
      });
      // Echoing the current branch is not a move and must not write it back,
      // or it could undo a concurrent move.
      await context.service.update(manager, 'asset-1', {
        originalName: 'renamed.png',
        branchId: 'branch-1',
      });
      expect(context.queryRaw).not.toHaveBeenCalled();
      expect(context.tx.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { originalName: 'renamed.png' } }),
      );
    });

    it('keeps the scope permission rules and checks them before any lock', async () => {
      const withPermissions = (
        ...permissions: string[]
      ): AuthenticatedPrincipal => ({ ...manager, permissions });
      // Branch asset into organization scope needs organization management.
      const toOrganization = serviceWith({ asset: branchAsset });
      const refused = await moveTo(
        toOrganization,
        null,
        withPermissions(
          PERMISSIONS.ASSET_MANAGE,
          PERMISSIONS.ASSET_READ,
          PERMISSIONS.BRANCH_MANAGE,
        ),
      );
      expect(refused).toBeInstanceOf(ForbiddenException);
      expect((refused as Error).message).toBe('Asset scope cannot be changed');
      expect(toOrganization.prisma.$transaction).not.toHaveBeenCalled();
      // Branch to branch needs branch management.
      const branchToBranch = serviceWith({ asset: branchAsset });
      Object.assign(branchToBranch.prisma, {
        userBranchAccess: {
          findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
        },
      });
      const noBranchManage = await moveTo(
        branchToBranch,
        'branch-2',
        withPermissions(
          PERMISSIONS.ASSET_MANAGE,
          PERMISSIONS.ASSET_READ,
          PERMISSIONS.ORGANIZATION_UPDATE,
        ),
      );
      expect((noBranchManage as Error).message).toBe(
        'Asset scope cannot be changed',
      );
      expect(branchToBranch.prisma.$transaction).not.toHaveBeenCalled();
      // A target branch outside the organization is refused before the
      // transaction.
      const foreignTarget = serviceWith({ asset: branchAsset });
      foreignTarget.prisma.branch.findFirst.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === 'branch-1' ? { id: 'branch-1' } : null,
      );
      const denied = await moveTo(foreignTarget, 'branch-other');
      expect((denied as Error).message).toBe('Branch access denied');
      expect(foreignTarget.prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});

describe('AssetsService usage', () => {
  const asset = {
    id: 'asset-1',
    organizationId: 'org-1',
    branchId: null as string | null,
    uploadedById: 'user-1',
    originalName: 'logo.png',
    storageKey: 'generated.png',
    mimeType: 'image/png',
    sizeBytes: 10,
    width: 1,
    height: 1,
    checksumSha256: 'hash',
    status: 'ACTIVE',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };
  // Stored revisions with their creative's organization and branch. The
  // raw-query fake applies the SQL's filter (organization and a top-level
  // value equal to the asset ID) and returns the SQL's row shape.
  type Revision = {
    id: string;
    number: number;
    organizationId: string;
    creativeId: string;
    creativeName: string;
    branchId: string;
    branchName: string;
    current: boolean;
    versionId: string;
    values: Record<string, unknown>;
  };
  const revision = (overrides: Partial<Revision>): Revision => ({
    id: 'revision-1',
    number: 1,
    organizationId: 'org-1',
    creativeId: 'creative-1',
    creativeName: 'Spring Sale',
    branchId: 'branch-1',
    branchName: 'North',
    current: true,
    versionId: 'version-1',
    values: { logo: 'asset-1', headline: 'Sale' },
    ...overrides,
  });
  type Logo = {
    organizationId: string;
    logoAssetId: string;
    branchId?: string;
    branchName?: string;
    branchCode?: string;
  };

  function serviceWith(stored: {
    revisions?: Revision[];
    organizationLogos?: Logo[];
    branchLogos?: Logo[];
    grants?: string[];
    fields?: Array<{
      versionId: string;
      key: string;
      label: string;
      type: string;
    }>;
    found?: typeof asset | null;
  }) {
    const queryRaw = vi.fn(
      async (_sql: TemplateStringsArray, ...parameters: unknown[]) => {
        const [organizationId, assetId] = parameters;
        return (stored.revisions ?? [])
          .filter(
            (item) =>
              item.organizationId === organizationId &&
              Object.values(item.values).includes(assetId),
          )
          .map((item) => ({
            revisionId: item.id,
            revisionNumber: item.number,
            templateVersionId: item.versionId,
            creativeId: item.creativeId,
            creativeName: item.creativeName,
            branchId: item.branchId,
            branchName: item.branchName,
            isCurrentRevision: item.current,
            fieldKeys: Object.keys(item.values)
              .filter((key) => item.values[key] === assetId)
              .sort(),
          }));
      },
    );
    const prisma = {
      $queryRaw: queryRaw,
      $transaction: vi.fn(),
      asset: {
        findFirst: vi
          .fn()
          .mockResolvedValue(stored.found === undefined ? asset : stored.found),
        update: vi.fn(),
      },
      branch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
        findMany: vi
          .fn()
          .mockResolvedValue(
            (stored.grants ?? []).map((branchId) => ({ branchId })),
          ),
      },
      brandProfile: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: { logoAssetId: string; organizationId: string };
          }) => {
            const logo = (stored.organizationLogos ?? []).find(
              (item) =>
                item.logoAssetId === where.logoAssetId &&
                item.organizationId === where.organizationId,
            );
            return logo ? { id: 'profile-1', displayName: 'AdFlow' } : null;
          },
        ),
        updateMany: vi.fn(),
      },
      branchBrandOverride: {
        findMany: vi.fn(
          async ({
            where,
          }: {
            where: {
              logoAssetId: string;
              branch: { organizationId: string };
            };
          }) =>
            (stored.branchLogos ?? [])
              .filter(
                (item) =>
                  item.logoAssetId === where.logoAssetId &&
                  item.organizationId === where.branch.organizationId,
              )
              .map((item) => ({
                branchId: item.branchId,
                branch: { name: item.branchName, code: item.branchCode },
              })),
        ),
      },
      templateField: {
        findMany: vi.fn().mockResolvedValue(stored.fields ?? []),
      },
    };
    const audit = { write: vi.fn() };
    const storage = { get: vi.fn(), put: vi.fn(), remove: vi.fn() };
    const service = new AssetsService(
      prisma as unknown as PrismaService,
      audit as never,
      storage as unknown as AssetStorage,
    );
    return { service, prisma, audit, storage, queryRaw };
  }

  it('lists every referencing revision with its creative, branch, and template field', async () => {
    const { service, prisma } = serviceWith({
      revisions: [
        revision({ id: 'revision-2', number: 2, current: true }),
        revision({
          id: 'revision-1',
          number: 1,
          current: false,
          values: { logo: 'asset-1', hero: 'asset-1' },
        }),
      ],
      fields: [
        { versionId: 'version-1', key: 'logo', label: 'Logo', type: 'LOGO' },
        { versionId: 'version-1', key: 'hero', label: 'Hero', type: 'IMAGE' },
      ],
    });
    const usage = await service.usage(manager, 'asset-1');
    expect(usage).toEqual({
      assetId: 'asset-1',
      inUse: true,
      creativeRevisions: [
        {
          creativeId: 'creative-1',
          creativeName: 'Spring Sale',
          branchId: 'branch-1',
          branchName: 'North',
          revisionId: 'revision-2',
          revisionNumber: 2,
          isCurrentRevision: true,
          fields: [{ key: 'logo', label: 'Logo', type: 'LOGO' }],
        },
        {
          creativeId: 'creative-1',
          creativeName: 'Spring Sale',
          branchId: 'branch-1',
          branchName: 'North',
          revisionId: 'revision-1',
          revisionNumber: 1,
          isCurrentRevision: false,
          fields: [
            { key: 'hero', label: 'Hero', type: 'IMAGE' },
            { key: 'logo', label: 'Logo', type: 'LOGO' },
          ],
        },
      ],
      organizationBrandProfile: null,
      branchBrandProfiles: [],
      hiddenReferenceCount: 0,
    });
    expect(prisma.templateField.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { versionId: 'version-1', key: { in: ['logo'] } },
          { versionId: 'version-1', key: { in: ['hero', 'logo'] } },
        ],
      },
      select: { versionId: true, key: true, label: true, type: true },
    });
  });

  it('identifies organization and branch logo use', async () => {
    const { service } = serviceWith({
      organizationLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
      branchLogos: [
        {
          organizationId: 'org-1',
          logoAssetId: 'asset-1',
          branchId: 'branch-1',
          branchName: 'North',
          branchCode: 'NORTH',
        },
      ],
    });
    const usage = await service.usage(manager, 'asset-1');
    expect(usage.inUse).toBe(true);
    expect(usage.organizationBrandProfile).toEqual({
      profileId: 'profile-1',
      displayName: 'AdFlow',
    });
    expect(usage.branchBrandProfiles).toEqual([
      { branchId: 'branch-1', branchName: 'North', branchCode: 'NORTH' },
    ]);
    expect(usage.creativeRevisions).toEqual([]);
  });

  it('excludes references from other organizations', async () => {
    const { service, queryRaw } = serviceWith({
      revisions: [revision({ organizationId: 'org-2' })],
      organizationLogos: [{ organizationId: 'org-2', logoAssetId: 'asset-1' }],
      branchLogos: [
        {
          organizationId: 'org-2',
          logoAssetId: 'asset-1',
          branchId: 'branch-x',
          branchName: 'Foreign',
          branchCode: 'X',
        },
      ],
    });
    const usage = await service.usage(manager, 'asset-1');
    expect(usage).toMatchObject({
      inUse: false,
      creativeRevisions: [],
      organizationBrandProfile: null,
      branchBrandProfiles: [],
      hiddenReferenceCount: 0,
    });
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual(['org-1', 'asset-1']);
  });

  it('reports an unused asset only after every lookup came back empty', async () => {
    const { service, prisma } = serviceWith({});
    await expect(service.usage(manager, 'asset-1')).resolves.toEqual({
      assetId: 'asset-1',
      inUse: false,
      creativeRevisions: [],
      organizationBrandProfile: null,
      branchBrandProfiles: [],
      hiddenReferenceCount: 0,
    });
    expect(prisma.templateField.findMany).not.toHaveBeenCalled();
  });

  it('counts but does not describe references in branches the caller cannot access', async () => {
    const branchReader: AuthenticatedPrincipal = {
      ...manager,
      permissions: [PERMISSIONS.ASSET_READ],
    };
    const { service, prisma } = serviceWith({
      grants: ['branch-1'],
      revisions: [
        revision({ id: 'revision-1' }),
        revision({
          id: 'revision-9',
          creativeId: 'creative-9',
          creativeName: 'Hidden',
          branchId: 'branch-2',
          branchName: 'South',
        }),
      ],
      branchLogos: [
        {
          organizationId: 'org-1',
          logoAssetId: 'asset-1',
          branchId: 'branch-2',
          branchName: 'South',
          branchCode: 'SOUTH',
        },
      ],
    });
    const usage = await service.usage(branchReader, 'asset-1');
    expect(usage.inUse).toBe(true);
    expect(usage.creativeRevisions.map((item) => item.revisionId)).toEqual([
      'revision-1',
    ]);
    expect(usage.branchBrandProfiles).toEqual([]);
    expect(usage.hiddenReferenceCount).toBe(2);
    expect(JSON.stringify(usage)).not.toMatch(/Hidden|South|branch-2/);
    expect(prisma.userBranchAccess.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        branch: { organizationId: 'org-1', status: 'ACTIVE' },
      },
      select: { branchId: true },
    });
  });

  it('reports a field missing from the template version with a null label', async () => {
    const { service } = serviceWith({ revisions: [revision({})], fields: [] });
    const usage = await service.usage(manager, 'asset-1');
    expect(usage.creativeRevisions[0]?.fields).toEqual([
      { key: 'logo', label: null, type: null },
    ]);
  });

  it('reports unknown, deleted, or other-organization assets as not found', async () => {
    const { service, prisma, queryRaw } = serviceWith({ found: null });
    await expect(service.usage(manager, 'asset-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.asset.findFirst).toHaveBeenCalledWith({
      where: { id: 'asset-x', organizationId: 'org-1', status: 'ACTIVE' },
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('requires asset read permission and branch access to the asset', async () => {
    const noRead = { ...manager, permissions: [] };
    const denied = serviceWith({});
    await expect(denied.service.usage(noRead, 'asset-1')).rejects.toThrow(
      'Permission denied',
    );
    expect(denied.queryRaw).not.toHaveBeenCalled();
    const branchReader = { ...manager, permissions: [PERMISSIONS.ASSET_READ] };
    const hidden = serviceWith({ found: { ...asset, branchId: 'branch-2' } });
    hidden.prisma.userBranchAccess.findFirst.mockResolvedValue(null);
    await expect(
      hidden.service.usage(branchReader, 'asset-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(hidden.queryRaw).not.toHaveBeenCalled();
  });

  it('only reads: no transaction, locks, writes, audit events, or storage access', async () => {
    const context = serviceWith({
      revisions: [revision({})],
      organizationLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
    });
    await context.service.usage(manager, 'asset-1');
    expect(context.prisma.$transaction).not.toHaveBeenCalled();
    expect(context.prisma.asset.update).not.toHaveBeenCalled();
    expect(context.prisma.brandProfile.updateMany).not.toHaveBeenCalled();
    expect(context.audit.write).not.toHaveBeenCalled();
    expect(context.storage.get).not.toHaveBeenCalled();
    expect(context.storage.put).not.toHaveBeenCalled();
    expect(context.storage.remove).not.toHaveBeenCalled();
    const sql = (
      context.queryRaw.mock.calls[0]?.[0] as TemplateStringsArray
    ).join('?');
    expect(sql).not.toMatch(/FOR (UPDATE|SHARE)|INSERT|UPDATE "|DELETE/i);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import { AssetsService } from './assets.service';
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
});

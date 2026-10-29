import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.local',
  permissions: ['users:branch-access:manage'],
  branches: [],
  sessionId: 'session-1',
};
const branch = {
  id: 'branch-1',
  name: 'North',
  code: 'NORTH',
  status: 'ACTIVE',
  address: null,
  city: null,
  state: null,
  pincode: null,
  phone: null,
  whatsapp: null,
  email: null,
  googleMapsUrl: null,
  timezone: 'Asia/Kolkata',
};

describe('UsersService branch access', () => {
  it('grants access idempotently using the unique user/branch key', async () => {
    const userFindFirst = vi.fn().mockResolvedValue({ id: 'user-1' });
    const branchFindFirst = vi.fn().mockResolvedValue(branch);
    const upsert = vi.fn().mockResolvedValue({ userId: 'user-1', branch });
    const tx = {
      userBranchAccess: { findUnique: vi.fn().mockResolvedValue(null), upsert },
      auditLog: { create: vi.fn() },
    };
    const service = new UsersService(
      {
        user: { findFirst: userFindFirst },
        branch: { findFirst: branchFindFirst },
        userBranchAccess: { upsert },
        $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
          callback(tx),
        ),
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await service.grantBranchAccess(admin, 'user-1', 'branch-1');
    expect(userFindFirst).toHaveBeenCalledWith({
      where: { id: 'user-1', organizationId: 'org-1' },
      select: { id: true },
    });
    expect(branchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'branch-1', organizationId: 'org-1', status: 'ACTIVE' },
      }),
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_branchId: { userId: 'user-1', branchId: 'branch-1' } },
        update: {},
      }),
    );
  });

  it('denies a cross-organization user before inspecting or granting a branch', async () => {
    const branchFindFirst = vi.fn();
    const upsert = vi.fn();
    const service = new UsersService(
      {
        user: { findFirst: vi.fn().mockResolvedValue(null) },
        branch: { findFirst: branchFindFirst },
        userBranchAccess: { upsert },
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.grantBranchAccess(admin, 'other-org-user', 'branch-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(branchFindFirst).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('denies a cross-organization branch even when the target user is local', async () => {
    const upsert = vi.fn();
    const service = new UsersService(
      {
        user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        branch: { findFirst: vi.fn().mockResolvedValue(null) },
        userBranchAccess: { upsert },
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.grantBranchAccess(admin, 'user-1', 'other-org-branch'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses grants to inactive branches', async () => {
    const service = new UsersService(
      {
        user: { findFirst: vi.fn().mockResolvedValue({ id: 'user-1' }) },
        branch: { findFirst: vi.fn().mockResolvedValue(null) },
        userBranchAccess: { upsert: vi.fn() },
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.grantBranchAccess(admin, 'user-1', 'inactive-branch'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokes access only after checking both records in the active organization', async () => {
    const userFindFirst = vi.fn().mockResolvedValue({ id: 'user-1' });
    const branchFindFirst = vi.fn().mockResolvedValue({ id: 'branch-1' });
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      userBranchAccess: { deleteMany },
      auditLog: { create: vi.fn() },
    };
    const service = new UsersService(
      {
        user: { findFirst: userFindFirst },
        branch: { findFirst: branchFindFirst },
        userBranchAccess: { deleteMany },
        $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
          callback(tx),
        ),
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.revokeBranchAccess(admin, 'user-1', 'branch-1'),
    ).resolves.toEqual({
      userId: 'user-1',
      branchId: 'branch-1',
      revoked: true,
    });
    expect(branchFindFirst).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1' },
      select: { id: true },
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', branchId: 'branch-1' },
    });
  });

  it('hides foreign users from the branch access listing', async () => {
    const service = new UsersService(
      {
        user: { findFirst: vi.fn().mockResolvedValue(null) },
        userBranchAccess: { findMany: vi.fn() },
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.listBranchAccess(admin, 'other-org-user'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

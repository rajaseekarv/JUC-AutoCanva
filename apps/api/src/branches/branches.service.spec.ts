import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { BranchesService } from './branches.service';

const admin: AuthenticatedPrincipal = {
  id: 'admin-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.local',
  permissions: ['branches:read', 'branches:manage'],
  branches: [],
  sessionId: 'session-1',
};
const branchUser: AuthenticatedPrincipal = {
  ...admin,
  id: 'user-1',
  permissions: ['branches:read'],
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

describe('BranchesService', () => {
  it('lists all organization branches for a manager and only active grants for a branch user', async () => {
    const findMany = vi.fn().mockResolvedValue([branch]);
    const service = new BranchesService(
      {
        branch: { findMany },
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await service.listAccessible(admin);
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: 'org-1',
    });
    await service.listAccessible(branchUser);
    expect(findMany.mock.calls[1]?.[0].where).toEqual({
      organizationId: 'org-1',
      status: 'ACTIVE',
      users: { some: { userId: 'user-1' } },
    });
  });

  it('creates a branch using the principal organization and normalizes the code', async () => {
    const create = vi.fn().mockResolvedValue(branch);
    const tx = { branch: { create }, auditLog: { create: vi.fn() } };
    const service = new BranchesService(
      {
        branch: { create },
        $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
          callback(tx),
        ),
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await service.create(admin, { name: 'North', code: 'north' });
    expect(create.mock.calls[0]?.[0].data).toEqual({
      name: 'North',
      code: 'NORTH',
      organizationId: 'org-1',
    });
  });

  it('cannot update a branch owned by another organization', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = { branch: { updateMany }, auditLog: { create: vi.fn() } };
    const service = new BranchesService(
      {
        branch: { updateMany },
        $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
          callback(tx),
        ),
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.update(admin, 'other-org-branch', { name: 'Changed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'other-org-branch', organizationId: 'org-1' },
      data: { name: 'Changed' },
    });
  });

  it('returns not found for an ungranted or inactive branch user request', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new BranchesService(
      {
        branch: { findFirst },
      } as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.getAccessible(branchUser, 'branch-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst.mock.calls[0]?.[0].where).toEqual({
      id: 'branch-2',
      organizationId: 'org-1',
      status: 'ACTIVE',
      users: { some: { userId: 'user-1' } },
    });
  });
});

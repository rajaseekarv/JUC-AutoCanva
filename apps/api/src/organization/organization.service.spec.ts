import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationService } from './organization.service';

const principal: AuthenticatedPrincipal = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.local',
  permissions: ['organizations:update'],
  branches: [],
  sessionId: 'session-1',
};

function serviceFor(prisma: object): OrganizationService {
  return new OrganizationService(
    prisma as PrismaService,
    { write: vi.fn().mockResolvedValue({}) } as never,
  );
}

describe('OrganizationService', () => {
  it('retrieves only the authenticated user organization', async () => {
    const findUnique = vi.fn().mockResolvedValue({
      id: 'org-1',
      name: 'Local',
      code: 'LOCAL',
      status: 'ACTIVE',
    });
    const service = serviceFor({ organization: { findUnique } });
    await expect(service.getOwn(principal)).resolves.toMatchObject({
      id: 'org-1',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { id: true, name: true, code: true, status: true },
    });
  });

  it('updates only the authenticated organization, without accepting an organization ID', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue({
      id: 'org-1',
      name: 'Updated',
      code: 'LOCAL',
      status: 'ACTIVE',
    });
    const organization = { updateMany, findUniqueOrThrow: findUnique };
    const tx = { organization, auditLog: { create: vi.fn() } };
    const service = serviceFor({
      organization,
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    });
    await expect(
      service.updateOwn(principal, { name: 'Updated' }),
    ).resolves.toMatchObject({ name: 'Updated' });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { name: 'Updated' },
    });
  });

  it('does not reveal an organization missing from the principal context', async () => {
    const service = serviceFor({
      organization: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(service.getOwn(principal)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

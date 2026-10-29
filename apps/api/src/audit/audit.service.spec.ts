import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

const user = {
  id: 'u1',
  organizationId: 'o1',
  name: 'User',
  email: 'user@example.local',
  permissions: [PERMISSIONS.AUDIT_READ],
  branches: [{ id: 'b1', name: 'North', code: 'N' }],
  sessionId: 's1',
};
describe('AuditService', () => {
  it('rejects audit reads without permission', async () => {
    const service = new AuditService({} as PrismaService);
    await expect(
      service.list({ ...user, permissions: [] }, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('limits log queries to the user organization and permitted branches', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = {
      auditLog: { findMany, count, findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((queries) => Promise.all(queries)),
    } as unknown as PrismaService;
    const service = new AuditService(prisma);
    await service.list(user, { page: 1, limit: 10 });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'o1',
      OR: [{ branchId: null }, { branchId: { in: ['b1'] } }],
    });
    await expect(service.get(user, 'foreign')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('rejects sensitive metadata keys before inserting an audit row', async () => {
    const create = vi.fn();
    const service = new AuditService({} as PrismaService);
    await expect(
      service.write({ auditLog: { create } } as never, {
        organizationId: 'o1',
        actorUserId: 'u1',
        action: 'x',
        entityType: 'x',
        entityId: 'x',
        metadata: { accessToken: 'unsafe' },
      }),
    ).rejects.toThrow('Sensitive audit metadata key rejected');
    expect(create).not.toHaveBeenCalled();
  });
});

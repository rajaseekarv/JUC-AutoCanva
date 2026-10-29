import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

const user = {
  id: 'u1',
  organizationId: 'o1',
  name: 'User',
  email: 'user@example.local',
  permissions: [],
  branches: [],
  sessionId: 's1',
};
describe('NotificationsService', () => {
  it('creates notifications idempotently with recipient plus event key', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'n1' });
    const service = new NotificationsService({} as PrismaService);
    const tx = { inAppNotification: { upsert } };
    await service.create(tx as never, {
      recipientUserId: 'u1',
      organizationId: 'o1',
      eventKey: 'task-1',
      type: 'REVIEW',
      title: 'Review',
      message: 'Ready',
      entityType: 'task',
      entityId: 'task-1',
    });
    expect(upsert.mock.calls[0][0].where).toEqual({
      recipientUserId_eventKey: { recipientUserId: 'u1', eventKey: 'task-1' },
    });
    expect(upsert.mock.calls[0][0].update).toEqual({});
  });
  it('scopes read and mark-read operations to the authenticated recipient', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const service = new NotificationsService({
      inAppNotification: { findFirst },
    } as unknown as PrismaService);
    await expect(service.get(user, 'another-users-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'another-users-id',
      recipientUserId: 'u1',
      organizationId: 'o1',
      OR: [{ branchId: null }, { branchId: { in: [] } }],
    });
  });
  it('marks only current user notifications read', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const service = new NotificationsService({
      inAppNotification: { updateMany },
    } as unknown as PrismaService);
    await service.markAllRead(user);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      recipientUserId: 'u1',
      organizationId: 'o1',
      readAt: null,
    });
  });

  it('filters recipient notifications to currently permitted branches', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const service = new NotificationsService({
      inAppNotification: { findMany },
    } as unknown as PrismaService);
    await service.list({
      ...user,
      branches: [{ id: 'branch-1', name: 'North', code: 'N' }],
    });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      recipientUserId: 'u1',
      organizationId: 'o1',
      OR: [{ branchId: null }, { branchId: { in: ['branch-1'] } }],
    });
  });
});

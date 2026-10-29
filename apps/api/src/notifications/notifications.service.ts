import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';

export type NotificationInput = {
  recipientUserId: string;
  organizationId: string;
  eventKey: string;
  type: string;
  title: string;
  message: string;
  entityType: string;
  entityId: string;
  branchId?: string | null;
  creativeId?: string | null;
  creativeRevisionId?: string | null;
  workflowInstanceId?: string | null;
  changeRequestId?: string | null;
};

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tx: Prisma.TransactionClient, input: NotificationInput) {
    return tx.inAppNotification.upsert({
      where: {
        recipientUserId_eventKey: {
          recipientUserId: input.recipientUserId,
          eventKey: input.eventKey,
        },
      },
      create: input,
      update: {},
    });
  }

  async list(user: AuthenticatedPrincipal, page = 1, limit = 25) {
    return this.prisma.inAppNotification.findMany({
      where: this.visibility(user),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async unreadCount(user: AuthenticatedPrincipal) {
    const count = await this.prisma.inAppNotification.count({
      where: { ...this.visibility(user), readAt: null },
    });
    return { count };
  }

  async get(user: AuthenticatedPrincipal, id: string) {
    const notification = await this.prisma.inAppNotification.findFirst({
      where: { id, ...this.visibility(user) },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  async markRead(user: AuthenticatedPrincipal, id: string) {
    const result = await this.prisma.inAppNotification.updateMany({
      where: { id, ...this.visibility(user), readAt: null },
      data: { readAt: new Date() },
    });
    if (
      !result.count &&
      !(await this.prisma.inAppNotification.findFirst({
        where: { id, ...this.visibility(user) },
        select: { id: true },
      }))
    )
      throw new NotFoundException('Notification not found');
    return this.get(user, id);
  }

  async markAllRead(user: AuthenticatedPrincipal) {
    const result = await this.prisma.inAppNotification.updateMany({
      where: { ...this.visibility(user), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  private visibility(
    user: AuthenticatedPrincipal,
  ): Prisma.InAppNotificationWhereInput {
    return {
      recipientUserId: user.id,
      organizationId: user.organizationId,
      ...(user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
        ? {}
        : {
            OR: [
              { branchId: null },
              { branchId: { in: user.branches.map(({ id }) => id) } },
            ],
          }),
    };
  }
}

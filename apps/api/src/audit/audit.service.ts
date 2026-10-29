import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';

export type AuditInput = {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  branchId?: string | null;
  creativeId?: string | null;
  creativeRevisionId?: string | null;
  workflowInstanceId?: string | null;
  changeRequestId?: string | null;
  metadata?: Prisma.InputJsonObject;
};

const forbiddenKey =
  /password|secret|token|authorization|cookie|file.?content|upload/i;

function validateMetadata(value: Prisma.InputJsonObject): void {
  const serialized = JSON.stringify(value);
  if (serialized.length > 4096) throw new Error('Audit metadata exceeds 4 KB');
  const inspect = (input: unknown): void => {
    if (Array.isArray(input)) return input.forEach(inspect);
    if (input && typeof input === 'object') {
      for (const [key, nested] of Object.entries(input)) {
        if (forbiddenKey.test(key))
          throw new Error('Sensitive audit metadata key rejected');
        inspect(nested);
      }
    }
  };
  inspect(value);
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async write(tx: Prisma.TransactionClient, input: AuditInput) {
    const metadata = input.metadata ?? {};
    validateMetadata(metadata);
    return tx.auditLog.create({ data: { ...input, metadata } });
  }

  async list(
    user: AuthenticatedPrincipal,
    filters: {
      action?: string;
      entityType?: string;
      entityId?: string;
      branchId?: string;
      actorUserId?: string;
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    },
  ) {
    this.requireRead(user);
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 25;
    const branchScope = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? undefined
      : { in: user.branches.map((branch) => branch.id) };
    if (
      filters.branchId &&
      branchScope &&
      !branchScope.in.includes(filters.branchId)
    )
      throw new NotFoundException('Audit log not found');
    const where: Prisma.AuditLogWhereInput = {
      organizationId: user.organizationId,
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.entityType ? { entityType: filters.entityType } : {}),
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      ...(filters.actorUserId ? { actorUserId: filters.actorUserId } : {}),
      ...(filters.branchId
        ? { branchId: filters.branchId }
        : branchScope
          ? { OR: [{ branchId: null }, { branchId: branchScope }] }
          : {}),
      ...(filters.from || filters.to
        ? {
            createdAt: {
              ...(filters.from ? { gte: new Date(filters.from) } : {}),
              ...(filters.to ? { lte: new Date(filters.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, page, limit, total };
  }

  async get(user: AuthenticatedPrincipal, id: string) {
    this.requireRead(user);
    const record = await this.prisma.auditLog.findFirst({
      where: {
        id,
        organizationId: user.organizationId,
        ...(user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
          ? {}
          : {
              OR: [
                { branchId: null },
                {
                  branchId: {
                    in: user.branches.map(({ id: branchId }) => branchId),
                  },
                },
              ],
            }),
      },
    });
    if (!record) throw new NotFoundException('Audit log not found');
    return record;
  }

  private requireRead(user: AuthenticatedPrincipal) {
    if (!user.permissions.includes(PERMISSIONS.AUDIT_READ))
      throw new ForbiddenException('Permission denied');
  }
}

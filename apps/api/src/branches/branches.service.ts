import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BranchDetails } from '@adflow/shared-types';
import { Prisma } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface BranchInput {
  name?: string;
  code?: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  googleMapsUrl?: string | null;
  timezone?: string;
}

export type BranchCreateInput = BranchInput & { name: string; code: string };

const branchDetailsSelect = {
  id: true,
  name: true,
  code: true,
  status: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
  phone: true,
  whatsapp: true,
  email: true,
  googleMapsUrl: true,
  timezone: true,
} satisfies Prisma.BranchSelect;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listAccessible(user: AuthenticatedPrincipal): Promise<BranchDetails[]> {
    const canManage = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE);
    return this.prisma.branch.findMany({
      where: {
        organizationId: user.organizationId,
        ...(canManage
          ? {}
          : { status: 'ACTIVE', users: { some: { userId: user.id } } }),
      },
      select: branchDetailsSelect,
      orderBy: { name: 'asc' },
    });
  }

  async getAccessible(
    user: AuthenticatedPrincipal,
    branchId: string,
  ): Promise<BranchDetails> {
    const canManage = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE);
    const branch = await this.prisma.branch.findFirst({
      where: {
        id: branchId,
        organizationId: user.organizationId,
        ...(canManage
          ? {}
          : { status: 'ACTIVE', users: { some: { userId: user.id } } }),
      },
      select: branchDetailsSelect,
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async create(
    user: AuthenticatedPrincipal,
    input: BranchCreateInput,
  ): Promise<BranchDetails> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const branch = await tx.branch.create({
          data: {
            ...input,
            code: input.code.toUpperCase(),
            organizationId: user.organizationId,
          },
          select: branchDetailsSelect,
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'branch.created',
          entityType: 'branch',
          entityId: branch.id,
          branchId: branch.id,
          metadata: { code: branch.code },
        });
        return branch;
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error))
        throw new ConflictException('Branch code is already in use');
      throw error;
    }
  }

  async update(
    user: AuthenticatedPrincipal,
    branchId: string,
    input: BranchInput,
  ): Promise<BranchDetails> {
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const result = await tx.branch.updateMany({
          where: { id: branchId, organizationId: user.organizationId },
          data: {
            ...input,
            ...(input.code ? { code: input.code.toUpperCase() } : {}),
          },
        });
        if (!result.count) throw new NotFoundException('Branch not found');
        const branch = await tx.branch.findFirstOrThrow({
          where: { id: branchId, organizationId: user.organizationId },
          select: branchDetailsSelect,
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'branch.updated',
          entityType: 'branch',
          entityId: branchId,
          branchId,
          metadata: {
            fields: Object.keys(input).filter(
              (key) =>
                key !== 'address' &&
                key !== 'phone' &&
                key !== 'whatsapp' &&
                key !== 'email' &&
                key !== 'googleMapsUrl',
            ),
          },
        });
        return branch;
      });
      return updated;
    } catch (error: unknown) {
      if (isUniqueConstraintError(error))
        throw new ConflictException('Branch code is already in use');
      throw error;
    }
  }

  async setStatus(
    user: AuthenticatedPrincipal,
    branchId: string,
    status: 'ACTIVE' | 'INACTIVE',
  ): Promise<BranchDetails> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.branch.updateMany({
        where: { id: branchId, organizationId: user.organizationId },
        data: { status },
      });
      if (!result.count) throw new NotFoundException('Branch not found');
      const branch = await tx.branch.findFirstOrThrow({
        where: { id: branchId, organizationId: user.organizationId },
        select: branchDetailsSelect,
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: status === 'ACTIVE' ? 'branch.activated' : 'branch.deactivated',
        entityType: 'branch',
        entityId: branchId,
        branchId,
        metadata: {},
      });
      return branch;
    });
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  OrganizationUserSummary,
  UserBranchAccessResponse,
} from '@adflow/shared-types';
import { Prisma } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

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

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listInOrganization(
    user: AuthenticatedPrincipal,
  ): Promise<OrganizationUserSummary[]> {
    return this.prisma.user.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, email: true, status: true },
      orderBy: { name: 'asc' },
    });
  }

  async listBranchAccess(
    user: AuthenticatedPrincipal,
    targetUserId: string,
  ): Promise<UserBranchAccessResponse[]> {
    await this.requireOrganizationUser(user, targetUserId);
    const accesses = await this.prisma.userBranchAccess.findMany({
      where: {
        userId: targetUserId,
        branch: { organizationId: user.organizationId },
      },
      select: { userId: true, branch: { select: branchDetailsSelect } },
      orderBy: { branch: { name: 'asc' } },
    });
    return accesses as UserBranchAccessResponse[];
  }

  async grantBranchAccess(
    user: AuthenticatedPrincipal,
    targetUserId: string,
    branchId: string,
  ): Promise<UserBranchAccessResponse> {
    await this.requireOrganizationUser(user, targetUserId);
    const branch = await this.prisma.branch.findFirst({
      where: {
        id: branchId,
        organizationId: user.organizationId,
        status: 'ACTIVE',
      },
      select: branchDetailsSelect,
    });
    if (!branch) throw new NotFoundException('User or branch not found');

    const access = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userBranchAccess.findUnique({
        where: { userId_branchId: { userId: targetUserId, branchId } },
        select: { userId: true },
      });
      const granted = await tx.userBranchAccess.upsert({
        where: { userId_branchId: { userId: targetUserId, branchId } },
        update: {},
        create: { userId: targetUserId, branchId },
        select: { userId: true, branch: { select: branchDetailsSelect } },
      });
      if (!existing)
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'user.branch_access.granted',
          entityType: 'user_branch_access',
          entityId: `${targetUserId}:${branchId}`,
          branchId,
          metadata: { targetUserId },
        });
      return granted;
    });
    return access as UserBranchAccessResponse;
  }

  async revokeBranchAccess(
    user: AuthenticatedPrincipal,
    targetUserId: string,
    branchId: string,
  ): Promise<{ userId: string; branchId: string; revoked: boolean }> {
    await this.requireOrganizationUser(user, targetUserId);
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('User or branch not found');

    const result = await this.prisma.$transaction(async (tx) => {
      const removed = await tx.userBranchAccess.deleteMany({
        where: { userId: targetUserId, branchId },
      });
      if (removed.count)
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'user.branch_access.revoked',
          entityType: 'user_branch_access',
          entityId: `${targetUserId}:${branchId}`,
          branchId,
          metadata: { targetUserId },
        });
      return removed;
    });
    return { userId: targetUserId, branchId, revoked: result.count > 0 };
  }

  private async requireOrganizationUser(
    user: AuthenticatedPrincipal,
    targetUserId: string,
  ): Promise<{ id: string }> {
    const targetUser = await this.prisma.user.findFirst({
      where: { id: targetUserId, organizationId: user.organizationId },
      select: { id: true },
    });
    if (!targetUser) throw new NotFoundException('User or branch not found');
    return targetUser;
  }
}

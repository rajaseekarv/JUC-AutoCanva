import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedPrincipal;
  params: Request['params'] & { branchId?: string };
}

@Injectable()
export class BranchAccessGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    const branchId = request.params.branchId;
    if (!user || !branchId)
      throw new ForbiddenException('Branch access denied');

    const canManageBranches = user.permissions.includes(
      PERMISSIONS.BRANCH_MANAGE,
    );
    const access = canManageBranches
      ? await this.prisma.branch.findFirst({
          where: { id: branchId, organizationId: user.organizationId },
          select: { id: true },
        })
      : await this.prisma.userBranchAccess.findFirst({
          where: {
            userId: user.id,
            branchId,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    if (!access) throw new ForbiddenException('Branch access denied');
    return true;
  }
}

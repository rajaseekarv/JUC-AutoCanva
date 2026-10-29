import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrganizationResponse } from '@adflow/shared-types';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface UpdateOrganizationInput {
  name?: string;
  code?: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getOwn(user: AuthenticatedPrincipal): Promise<OrganizationResponse> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: { id: true, name: true, code: true, status: true },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    return organization;
  }

  async updateOwn(
    user: AuthenticatedPrincipal,
    input: UpdateOrganizationInput,
  ): Promise<OrganizationResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const result = await tx.organization.updateMany({
          where: { id: user.organizationId },
          data: input,
        });
        if (!result.count)
          throw new NotFoundException('Organization not found');
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: user.organizationId },
          select: { id: true, name: true, code: true, status: true },
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'organization.updated',
          entityType: 'organization',
          entityId: user.organizationId,
          metadata: { fields: Object.keys(input) },
        });
        return organization;
      });
    } catch (error: unknown) {
      if (isUniqueConstraintError(error))
        throw new ConflictException('Organization code is already in use');
      throw error;
    }
  }
}

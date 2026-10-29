import { Injectable } from '@nestjs/common';
import { PERMISSIONS } from '../../auth/permissions';
import { PrismaService } from '../../prisma/prisma.service';

export const CANVA_PRINCIPAL_CHECK = Symbol('CANVA_PRINCIPAL_CHECK');

export interface CanvaPrincipalCheck {
  // Whether the user who started the authorization still holds an active,
  // unrevoked session and the integration-management permission in the same
  // organization. The callback carries no JWT, so this replaces the guard.
  stillAuthorized(owner: {
    userId: string;
    sessionId: string;
    organizationId: string;
  }): Promise<boolean>;
}

// Read-only: mirrors JwtAuthGuard's session and role rules.
@Injectable()
export class PrismaCanvaPrincipalCheck implements CanvaPrincipalCheck {
  constructor(private readonly prisma: PrismaService) {}

  async stillAuthorized(owner: {
    userId: string;
    sessionId: string;
    organizationId: string;
  }): Promise<boolean> {
    const session = await this.prisma.authSession.findFirst({
      where: {
        id: owner.sessionId,
        userId: owner.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        user: {
          select: {
            status: true,
            organizationId: true,
            roleAssignments: {
              select: {
                role: {
                  select: {
                    organizationId: true,
                    permissions: {
                      select: { permission: { select: { code: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const user = session?.user;
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      user.organizationId !== owner.organizationId
    )
      return false;
    return user.roleAssignments.some(
      ({ role }) =>
        role.organizationId === owner.organizationId &&
        role.permissions.some(
          ({ permission }) =>
            permission.code === PERMISSIONS.CANVA_INTEGRATION_MANAGE,
        ),
    );
  }
}

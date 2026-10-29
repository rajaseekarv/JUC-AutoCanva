import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedPrincipal } from './auth.types';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedPrincipal;
}

interface AccessTokenClaims {
  sub?: unknown;
  sid?: unknown;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Authentication required');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwtService.verifyAsync<AccessTokenClaims>(token, {
        issuer: 'adflow-api',
      });
    } catch {
      throw new UnauthorizedException('Authentication required');
    }
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') {
      throw new UnauthorizedException('Authentication required');
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: claims.sid,
        userId: claims.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          include: {
            branchAccess: { include: { branch: true } },
            roleAssignments: {
              include: {
                role: {
                  include: { permissions: { include: { permission: true } } },
                },
              },
            },
          },
        },
      },
    });

    if (!session || session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Authentication required');
    }

    const user = session.user;
    const permissions = new Set<string>();
    for (const assignment of user.roleAssignments) {
      if (assignment.role.organizationId !== user.organizationId) continue;
      for (const rolePermission of assignment.role.permissions) {
        permissions.add(rolePermission.permission.code);
      }
    }

    request.user = {
      id: user.id,
      organizationId: user.organizationId,
      name: user.name,
      email: user.email,
      permissions: [...permissions],
      branches: user.branchAccess
        .filter(
          (access) =>
            access.branch.organizationId === user.organizationId &&
            access.branch.status === 'ACTIVE',
        )
        .map(({ branch }) => ({
          id: branch.id,
          name: branch.name,
          code: branch.code,
        })),
      sessionId: session.id,
    };
    return true;
  }
}

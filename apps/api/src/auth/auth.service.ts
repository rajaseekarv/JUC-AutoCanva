import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { LoginResponse } from '@adflow/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedPrincipal } from './auth.types';
import { AuditService } from '../audit/audit.service';

const INVALID_CREDENTIALS = 'Invalid email or password';
const accessTokenTtlSeconds = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
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
    });

    let passwordIsValid = false;
    if (user?.passwordHash) {
      try {
        passwordIsValid = await argon2.verify(user.passwordHash, password);
      } catch {
        passwordIsValid = false;
      }
    }
    if (!user || user.status !== 'ACTIVE' || !passwordIsValid) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const expiresAt = new Date(Date.now() + accessTokenTtlSeconds * 1000);
    const session = await this.prisma.$transaction(async (tx) => {
      const created = await tx.authSession.create({
        data: { userId: user.id, expiresAt },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'auth_session',
        entityId: created.id,
        metadata: { expiresAt: expiresAt.toISOString() },
      });
      return created;
    });
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, sid: session.id },
      { expiresIn: accessTokenTtlSeconds, issuer: 'adflow-api' },
    );

    const permissions = new Set<string>();
    for (const assignment of user.roleAssignments) {
      if (assignment.role.organizationId !== user.organizationId) continue;
      for (const rolePermission of assignment.role.permissions) {
        permissions.add(rolePermission.permission.code);
      }
    }

    return {
      accessToken,
      expiresIn: accessTokenTtlSeconds,
      user: {
        id: user.id,
        organizationId: user.organizationId,
        name: user.name,
        email: user.email,
        permissions: [...permissions],
        // Same filter as JwtAuthGuard so login and /auth/me agree.
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
      },
    };
  }

  async logout(
    userId: string,
    sessionId: string,
    organizationId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.authSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count)
        await this.audit.write(tx, {
          organizationId,
          actorUserId: userId,
          action: 'auth.logout',
          entityType: 'auth_session',
          entityId: sessionId,
          metadata: {},
        });
    });
  }

  currentUser(user: AuthenticatedPrincipal) {
    return {
      id: user.id,
      organizationId: user.organizationId,
      name: user.name,
      email: user.email,
      permissions: user.permissions,
      branches: user.branches,
    };
  }
}

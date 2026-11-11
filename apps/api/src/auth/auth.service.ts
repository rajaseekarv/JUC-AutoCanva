import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import type { LoginResponse } from '@adflow/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedPrincipal } from './auth.types';
import { AuditService } from '../audit/audit.service';

const INVALID_CREDENTIALS = 'Invalid email or password';
const accessTokenTtlSeconds = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);

// Why a login for an existing account was refused (audit metadata only;
// the API response never says).
export type LoginFailureReason =
  'INVALID_PASSWORD' | 'INACTIVE' | 'PASSWORD_NOT_SET';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
      // An unknown email has no organization to audit in, so only attempts
      // against an existing account are recorded. The response is the same
      // in every case.
      if (user)
        await this.recordFailedLogin(user, {
          active: user.status === 'ACTIVE',
          hasPassword: Boolean(user.passwordHash),
        });
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

  // Records a refused login for an existing account. Only a reason code is
  // stored: never the password, the submitted email, a hash or a token. The
  // actor is unknown (the request is unauthenticated), so actorUserId is
  // null and the account is the entity. A failure to write the record never
  // changes the 401 the caller receives.
  private async recordFailedLogin(
    user: { id: string; organizationId: string },
    state: { active: boolean; hasPassword: boolean },
  ): Promise<void> {
    const reason: LoginFailureReason = !state.active
      ? 'INACTIVE'
      : state.hasPassword
        ? 'INVALID_PASSWORD'
        : 'PASSWORD_NOT_SET';
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: null,
          action: 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
          metadata: { reason },
        });
      });
    } catch {
      this.logger.warn('A failed login could not be recorded in the audit log');
    }
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

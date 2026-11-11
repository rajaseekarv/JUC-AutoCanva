import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

const password = 'local-test-password-42';
const branch = {
  id: 'branch-1',
  name: 'Central',
  code: 'CENTRAL',
  organizationId: 'org-1',
  status: 'ACTIVE',
};

function makePrisma(user: object | null) {
  const authSession = {
    create: vi.fn().mockResolvedValue({ id: 'session-1' }),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  return {
    user: { findUnique: vi.fn().mockResolvedValue(user) },
    authSession,
    $transaction: vi.fn((callback: (tx: unknown) => unknown) =>
      callback({ authSession, auditLog: { create: vi.fn() } }),
    ),
  } as unknown as PrismaService;
}

describe('AuthService', () => {
  let prisma: PrismaService;
  let jwt: JwtService;
  let service: AuthService;
  let audit: { write: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    prisma = makePrisma({
      id: 'user-1',
      organizationId: 'org-1',
      name: 'Branch Admin',
      email: 'admin@example.local',
      passwordHash,
      status: 'ACTIVE',
      branchAccess: [{ branch }],
      roleAssignments: [
        {
          role: {
            organizationId: 'org-1',
            permissions: [{ permission: { code: 'branches:read' } }],
          },
        },
      ],
    });
    jwt = {
      signAsync: vi.fn().mockResolvedValue('signed-access-token'),
    } as unknown as JwtService;
    audit = { write: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
    service = new AuthService(prisma, jwt, audit as never);
  });

  it('logs in with a valid password and returns only safe identity data', async () => {
    const response = await service.login(' ADMIN@example.local ', password);
    expect(response.accessToken).toBe('signed-access-token');
    expect(response.user).toMatchObject({
      id: 'user-1',
      email: 'admin@example.local',
      permissions: ['branches:read'],
      branches: [{ id: 'branch-1', name: 'Central', code: 'CENTRAL' }],
    });
    expect(response.user).not.toHaveProperty('passwordHash');
    expect(audit.write).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        action: 'auth.login',
        organizationId: 'org-1',
        actorUserId: 'user-1',
      }),
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: 'admin@example.local' } }),
    );
  });

  it('returns only active branches at login, matching /auth/me', async () => {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    prisma = makePrisma({
      id: 'user-1',
      organizationId: 'org-1',
      name: 'Branch Admin',
      email: 'admin@example.local',
      passwordHash,
      status: 'ACTIVE',
      branchAccess: [
        {
          branch: {
            id: 'branch-0',
            name: 'Closed',
            code: 'CLOSED',
            organizationId: 'org-1',
            status: 'INACTIVE',
          },
        },
        { branch },
      ],
      roleAssignments: [],
    });
    service = new AuthService(prisma, jwt, audit as never);
    const response = await service.login('admin@example.local', password);
    expect(response.user.branches).toEqual([
      { id: 'branch-1', name: 'Central', code: 'CENTRAL' },
    ]);
  });

  it('rejects an invalid password with a generic authentication error', async () => {
    await expect(
      service.login('admin@example.local', 'wrong-password'),
    ).rejects.toThrow(new UnauthorizedException('Invalid email or password'));
  });

  it('records a successful logout in the same transaction as session revocation', async () => {
    await service.logout('user-1', 'session-1', 'org-1');
    expect(audit.write).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'auth.logout', entityId: 'session-1' }),
    );
  });

  it('writes no audit record when the session was already revoked', async () => {
    vi.mocked(
      (prisma as unknown as { authSession: { updateMany: () => unknown } })
        .authSession.updateMany,
    ).mockResolvedValueOnce({ count: 0 });
    await service.logout('user-1', 'session-1', 'org-1');
    expect(audit.write).not.toHaveBeenCalled();
  });

  // Stage 11: refused logins for existing accounts are audited with a reason
  // code only; the response never changes.
  describe('failed login auditing', () => {
    const account = async (extra: object) =>
      makePrisma({
        id: 'user-1',
        organizationId: 'org-1',
        name: 'Branch Admin',
        email: 'admin@example.local',
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        status: 'ACTIVE',
        branchAccess: [],
        roleAssignments: [],
        ...extra,
      });
    const refused = new UnauthorizedException('Invalid email or password');
    const failedAudit = (reason: string) => ({
      organizationId: 'org-1',
      actorUserId: null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: 'user-1',
      metadata: { reason },
    });

    it.each([
      ['a wrong password', {}, 'wrong-password', 'INVALID_PASSWORD'],
      ['an inactive account', { status: 'DISABLED' }, password, 'INACTIVE'],
      [
        'an inactive account with a wrong password',
        { status: 'DISABLED' },
        'wrong-password',
        'INACTIVE',
      ],
      [
        'an account without a password',
        { passwordHash: null },
        password,
        'PASSWORD_NOT_SET',
      ],
    ])(
      'records %s as one auth.login_failed with only a reason code',
      async (_case, extra, attempt, reason) => {
        prisma = await account(extra);
        service = new AuthService(prisma, jwt, audit as never);
        await expect(
          service.login('admin@example.local', attempt),
        ).rejects.toThrow(refused);
        expect(audit.write).toHaveBeenCalledTimes(1);
        expect(audit.write).toHaveBeenCalledWith(
          expect.any(Object),
          failedAudit(reason),
        );
        const stored = JSON.stringify(audit.write.mock.calls[0]![1]);
        for (const secret of [attempt, password, 'admin@example.local'])
          expect(stored).not.toContain(secret);
        expect(stored).not.toMatch(/argon2|token/i);
        expect(prisma.authSession.create).not.toHaveBeenCalled();
        expect(jwt.signAsync).not.toHaveBeenCalled();
      },
    );

    it('records nothing for an unknown email, with the same response', async () => {
      prisma = makePrisma(null);
      service = new AuthService(prisma, jwt, audit as never);
      await expect(
        service.login('nobody@example.local', password),
      ).rejects.toThrow(refused);
      expect(audit.write).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('still answers 401 with the same message when the record cannot be written', async () => {
      prisma = await account({});
      audit.write.mockRejectedValueOnce(new Error('database unavailable'));
      service = new AuthService(prisma, jwt, audit as never);
      await expect(
        service.login('admin@example.local', 'wrong-password'),
      ).rejects.toThrow(refused);
    });
  });
});

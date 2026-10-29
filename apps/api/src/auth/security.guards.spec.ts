import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { BranchAccessGuard } from '../branches/branch-access.guard';
import type { AuthenticatedPrincipal } from './auth.types';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionGuard } from './permission.guard';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator';

const principal: AuthenticatedPrincipal = {
  id: 'user-1',
  organizationId: 'org-1',
  name: 'Branch User',
  email: 'branch@example.local',
  permissions: ['branches:read'],
  branches: [{ id: 'branch-1', name: 'Central', code: 'CENTRAL' }],
  sessionId: 'session-1',
};

function requestContext(request: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => vi.fn(),
    getClass: () => class TestController {},
  } as unknown as ExecutionContext;
}

describe('server-side authorization guards', () => {
  it('rejects an unauthenticated protected request', async () => {
    const guard = new JwtAuthGuard(
      { verifyAsync: vi.fn() } as never,
      {} as PrismaService,
    );
    await expect(
      guard.canActivate(requestContext({ headers: {}, params: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a valid token whose session is revoked or expired', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const guard = new JwtAuthGuard(
      {
        verifyAsync: vi
          .fn()
          .mockResolvedValue({ sub: 'user-1', sid: 'session-1' }),
      } as never,
      { authSession: { findFirst } } as unknown as PrismaService,
    );
    await expect(
      guard.canActivate(
        requestContext({
          headers: { authorization: 'Bearer signed-token' },
          params: {},
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        id: 'session-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
    });
  });

  it('rejects a token that fails signature or expiry verification', async () => {
    const findFirst = vi.fn();
    const guard = new JwtAuthGuard(
      {
        verifyAsync: vi.fn().mockRejectedValue(new Error('jwt expired')),
      } as never,
      { authSession: { findFirst } } as unknown as PrismaService,
    );
    await expect(
      guard.canActivate(
        requestContext({
          headers: { authorization: 'Bearer expired-token' },
          params: {},
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('allows a user to access an explicitly authorized branch in their organization', async () => {
    const findFirst = vi.fn().mockResolvedValue({ branchId: 'branch-1' });
    const guard = new BranchAccessGuard({
      userBranchAccess: { findFirst },
    } as unknown as PrismaService);
    await expect(
      guard.canActivate(
        requestContext({ user: principal, params: { branchId: 'branch-1' } }),
      ),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        branchId: 'branch-1',
        branch: { organizationId: 'org-1', status: 'ACTIVE' },
      },
      select: { branchId: true },
    });
  });

  it('denies a branch without a user-to-branch grant', async () => {
    const guard = new BranchAccessGuard({
      userBranchAccess: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService);
    await expect(
      guard.canActivate(
        requestContext({ user: principal, params: { branchId: 'branch-2' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('denies a branch grant when the branch is inactive', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const guard = new BranchAccessGuard({
      userBranchAccess: { findFirst },
    } as unknown as PrismaService);
    await expect(
      guard.canActivate(
        requestContext({ user: principal, params: { branchId: 'branch-1' } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          branch: { organizationId: 'org-1', status: 'ACTIVE' },
        }),
      }),
    );
  });

  it('allows a branch manager to administer an inactive branch only in their organization', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'branch-1' });
    const guard = new BranchAccessGuard({
      branch: { findFirst },
    } as unknown as PrismaService);
    const manager = {
      ...principal,
      permissions: ['branches:read', 'branches:manage'],
    };
    await expect(
      guard.canActivate(
        requestContext({ user: manager, params: { branchId: 'branch-1' } }),
      ),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'branch-1', organizationId: 'org-1' },
      select: { id: true },
    });
  });

  it('prevents bypass by changing the branch ID in the request', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const guard = new BranchAccessGuard({
      userBranchAccess: { findFirst },
    } as unknown as PrismaService);
    await expect(
      guard.canActivate(
        requestContext({
          user: principal,
          params: { branchId: 'other-org-branch' },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: {
        userId: 'user-1',
        branchId: 'other-org-branch',
        branch: { organizationId: 'org-1', status: 'ACTIVE' },
      },
    });
  });

  it('enforces permission metadata on the server', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue(['branches:manage']),
    } as unknown as Reflector;
    const guard = new PermissionGuard(reflector);
    const context = requestContext({ user: principal });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      REQUIRED_PERMISSIONS,
      expect.any(Array),
    );
  });
});

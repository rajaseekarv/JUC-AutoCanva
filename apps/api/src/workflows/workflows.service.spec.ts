import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkflowsService } from './workflows.service';

const principal: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  name: 'Operator',
  email: 'operator@example.local',
  branches: [],
  permissions: [
    PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.WORKFLOW_START,
    PERMISSIONS.WORKFLOW_TRANSITION,
  ],
};

describe('WorkflowsService authorization', () => {
  it('does not start a workflow when the actor lacks access to the creative branch', async () => {
    const tx = {
      creative: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'creative-1',
          organizationId: 'org-1',
          branchId: 'branch-other',
        }),
      },
      userBranchAccess: { findFirst: vi.fn().mockResolvedValue(null) },
      workflowInstance: { findFirst: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.start(principal, 'creative-1', 'workflow-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.workflowInstance.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a client supplied transition key that is not defined from the current stage', async () => {
    const tx = {
      workflowInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'instance-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          status: 'RUNNING',
          currentStageId: 'stage-current',
          currentStage: { requiredPermission: null },
          workflowVersionId: 'version-1',
        }),
        updateMany: vi.fn(),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      workflowTransition: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.transition(principal, 'instance-1', 'invented-destination'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.workflowInstance.updateMany).not.toHaveBeenCalled();
  });

  it('enforces stage and transition permissions server-side', async () => {
    const tx = {
      workflowInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'instance-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          status: 'RUNNING',
          currentStageId: 'stage-current',
          currentStage: {
            requiredPermission: 'workflows:manage',
            assignedUserId: null,
            assignedPermission: null,
          },
          workflowVersionId: 'version-1',
        }),
        updateMany: vi.fn(),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      workflowTransition: {
        findFirst: vi.fn().mockResolvedValue({
          key: 'submit',
          destinationStageId: 'stage-next',
          destination: {
            id: 'stage-next',
            requiredPermission: null,
            assignedUserId: null,
          },
          requiredPermission: null,
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.transition(principal, 'instance-1', 'submit'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.workflowInstance.updateMany).not.toHaveBeenCalled();
  });

  it('does not allow ordinary workflow transitions to bypass a review decision', async () => {
    const tx = {
      workflowInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'instance-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          status: 'RUNNING',
          currentStageId: 'stage-review',
          workflowVersionId: 'version-1',
          currentStage: {
            requiresReview: true,
            requiredPermission: null,
            assignedUserId: null,
            assignedPermission: null,
          },
        }),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      workflowTransition: { findFirst: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.transition(principal, 'instance-1', 'approve'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.workflowTransition.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a concurrent transition when the optimistic current-stage update loses', async () => {
    const tx = {
      workflowInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'instance-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          status: 'RUNNING',
          currentStageId: 'stage-current',
          currentStage: {
            requiredPermission: null,
            assignedUserId: null,
            assignedPermission: null,
          },
          workflowVersionId: 'version-1',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      workflowTransition: {
        findFirst: vi.fn().mockResolvedValue({
          key: 'submit',
          destinationStageId: 'stage-next',
          destination: {
            id: 'stage-next',
            key: 'ready',
            requiredPermission: null,
            assignedUserId: null,
            assignedPermission: null,
            isTerminal: false,
          },
          requiredPermission: null,
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.transition(principal, 'instance-1', 'submit'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ReviewDecisionType } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import type { WorkflowsService } from '../workflows/workflows.service';
import { ApprovalsService } from './approvals.service';

const user: AuthenticatedPrincipal = {
  id: 'reviewer-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  name: 'Reviewer',
  email: 'reviewer@example.local',
  branches: [],
  permissions: [
    PERMISSIONS.APPROVAL_READ,
    PERMISSIONS.APPROVAL_DECIDE,
    PERMISSIONS.CHANGE_REQUEST_CREATE,
    PERMISSIONS.CHANGE_REQUEST_READ,
    PERMISSIONS.CHANGE_REQUEST_RESOLVE,
    PERMISSIONS.COMMENT_READ,
    PERMISSIONS.COMMENT_CREATE,
  ],
};

function setup(
  options: {
    currentRevision?: string | null;
    branch?: boolean;
    assignment?: string | null;
    transition?: boolean;
    updateCount?: number;
    transitionFails?: boolean;
  } = {},
) {
  const task = {
    id: 'task-1',
    instanceId: 'instance-1',
    stageId: 'stage-review',
    assignedUserId:
      options.assignment === undefined ? user.id : options.assignment,
    requiredPermission: null,
    status: 'OPEN',
    stage: {
      id: 'stage-review',
      key: 'review',
      name: 'Review',
      requiresReview: true,
    },
    instance: {
      id: 'instance-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      creativeId: 'creative-1',
      creativeRevisionId: 'revision-1',
      workflowVersionId: 'version-1',
      currentStageId: 'stage-review',
      status: 'RUNNING',
      workflow: { name: 'Local' },
      creative: {
        id: 'creative-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        name: 'Post',
        currentRevisionId:
          options.currentRevision === undefined
            ? 'revision-1'
            : options.currentRevision,
        currentRevision: null,
      },
    },
  };
  const tx = {
    workflowTask: {
      findFirst: vi.fn().mockResolvedValue(task),
      updateMany: vi
        .fn()
        .mockResolvedValue({ count: options.updateCount ?? 1 }),
    },
    userBranchAccess: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.branch === false ? null : { branchId: 'branch-1' },
        ),
    },
    creativeRevision: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.currentRevision === null
            ? null
            : { id: 'revision-1', revisionNumber: 2 },
        ),
    },
    workflowTransition: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options.transition === false ? null : { key: 'approve' },
        ),
    },
    approvalDecision: {
      create: vi.fn().mockResolvedValue({
        id: 'decision-1',
        decision: ReviewDecisionType.APPROVED,
      }),
    },
    changeRequest: { create: vi.fn().mockResolvedValue({ id: 'change-1' }) },
  };
  const prisma = {
    $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const workflows = {
    transitionInTransaction: vi
      .fn()
      .mockImplementation(() =>
        options.transitionFails
          ? Promise.reject(new ConflictException('raced'))
          : Promise.resolve({ id: 'instance-1' }),
      ),
  };
  const service = new ApprovalsService(
    prisma as unknown as PrismaService,
    workflows as unknown as WorkflowsService,
    { write: vi.fn().mockResolvedValue({}) } as never,
    { create: vi.fn().mockResolvedValue({}) } as never,
  );
  return { service, prisma, tx, workflows };
}

describe('ApprovalsService', () => {
  it('records a decision against the exact current revision and reuses the workflow transition', async () => {
    const { service, tx, workflows } = setup();
    const result = await service.decide(user, 'task-1', {
      decision: ReviewDecisionType.APPROVED,
    });
    expect(result).toMatchObject({ id: 'decision-1' });
    expect(tx.approvalDecision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creativeRevisionId: 'revision-1',
          revisionNumber: 2,
          reviewerId: user.id,
        }),
      }),
    );
    expect(tx.workflowTask.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'OPEN' }),
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
    expect(workflows.transitionInTransaction).toHaveBeenCalled();
  });

  it('rejects a stale creative revision before writing a decision', async () => {
    const { service, tx } = setup({ currentRevision: null });
    await expect(
      service.decide(user, 'task-1', { decision: ReviewDecisionType.APPROVED }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.approvalDecision.create).not.toHaveBeenCalled();
  });

  it('rejects an unassigned reviewer and a user without branch access', async () => {
    const wrongReviewer = setup({ assignment: 'someone-else' });
    await expect(
      wrongReviewer.service.decide(user, 'task-1', {
        decision: ReviewDecisionType.APPROVED,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const wrongBranch = setup({ branch: false });
    await expect(
      wrongBranch.service.decide(user, 'task-1', {
        decision: ReviewDecisionType.APPROVED,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a task completion race and does not return a decision', async () => {
    const { service, tx, workflows } = setup({ updateCount: 0 });
    await expect(
      service.decide(user, 'task-1', { decision: ReviewDecisionType.APPROVED }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(workflows.transitionInTransaction).not.toHaveBeenCalled();
    expect(tx.changeRequest.create).not.toHaveBeenCalled();
  });

  it('rolls decision work back when the workflow transition cannot commit', async () => {
    const { service, prisma, workflows } = setup({ transitionFails: true });
    await expect(
      service.decide(user, 'task-1', { decision: ReviewDecisionType.APPROVED }),
    ).rejects.toThrow('raced');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(workflows.transitionInTransaction).toHaveBeenCalledTimes(1);
  });

  it('requires a reason for changes and creates a revision-linked change request', async () => {
    const missingReason = setup();
    await expect(
      missingReason.service.decide(user, 'task-1', {
        decision: ReviewDecisionType.CHANGES_REQUESTED,
      }),
    ).rejects.toThrow('A reason is required');
    const { service, tx } = setup();
    await service.decide(user, 'task-1', {
      decision: ReviewDecisionType.CHANGES_REQUESTED,
      reason: 'Update the offer',
      explanation: 'Keep the price label aligned with the approved copy.',
    });
    expect(tx.changeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creativeRevisionId: 'revision-1',
          revisionNumber: 2,
          requestedChanges: 'Update the offer',
          explanation: 'Keep the price label aligned with the approved copy.',
        }),
      }),
    );
  });

  it('requires change-request resolution permission before checking or mutating a request', async () => {
    const prisma = { changeRequest: { findFirst: vi.fn() } };
    const service = new ApprovalsService(
      prisma as unknown as PrismaService,
      {} as WorkflowsService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    const reviewer = {
      ...user,
      permissions: user.permissions.filter(
        (permission) => permission !== PERMISSIONS.CHANGE_REQUEST_RESOLVE,
      ),
    };
    await expect(
      service.resolveChangeRequest(reviewer, 'request-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.changeRequest.findFirst).not.toHaveBeenCalled();
  });

  it('records an authorized change-request resolution with actor and timestamp', async () => {
    const tx = {
      changeRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'request-1', status: 'RESOLVED' }),
      },
    };
    const prisma = {
      changeRequest: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'request-1',
          branchId: 'branch-1',
          status: 'IN_PROGRESS',
        }),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new ApprovalsService(
      prisma as unknown as PrismaService,
      {} as WorkflowsService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.resolveChangeRequest(user, 'request-1'),
    ).resolves.toMatchObject({ status: 'RESOLVED' });
    expect(tx.changeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['IN_PROGRESS'] } }),
        data: expect.objectContaining({
          status: 'RESOLVED',
          resolvedById: user.id,
          resolvedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('rejects a comment reply whose parent belongs to another revision', async () => {
    const prisma = {
      creative: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'creative-1', branchId: 'branch-1' }),
      },
      creativeRevision: {
        findUnique: vi.fn().mockResolvedValue({ id: 'revision-3' }),
      },
      creativeComment: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
    };
    const service = new ApprovalsService(
      prisma as unknown as PrismaService,
      {} as WorkflowsService,
      { write: vi.fn().mockResolvedValue({}) } as never,
      { create: vi.fn().mockResolvedValue({}) } as never,
    );
    await expect(
      service.addComment(user, 'creative-1', 3, 'Reply', 'foreign-comment'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.creativeComment.create).not.toHaveBeenCalled();
  });
});

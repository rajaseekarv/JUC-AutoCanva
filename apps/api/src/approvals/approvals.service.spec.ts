import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma, ReviewDecisionType } from '@prisma/client';
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
    startedBy?: string;
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
      startedById: options.startedBy ?? 'submitter-1',
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
  const notifications = { create: vi.fn().mockResolvedValue({}) };
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
    notifications as never,
  );
  return { service, prisma, tx, workflows, notifications };
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

  // Regression (Stage 10 PostgreSQL run): PostgreSQL may abort the decision
  // instead (deadlock with a concurrent cancellation); Prisma can report that
  // as an unknown request error, which must be a retryable 409, not a 500.
  it('maps a deadlock reported as an unknown request error to 409', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockImplementationOnce(async () => {
      throw new Prisma.PrismaClientUnknownRequestError(
        'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR" }) })',
        { clientVersion: 'test' },
      );
    });
    const attempt = service.decide(user, 'task-1', {
      decision: ReviewDecisionType.APPROVED,
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(
      'Review changed concurrently; reload and retry',
    );
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

describe('ApprovalsService self-approval', () => {
  it.each([ReviewDecisionType.APPROVED, ReviewDecisionType.CHANGES_REQUESTED])(
    'refuses a %s decision by the user who started the run, even when assigned',
    async (decision) => {
      const { service, tx, workflows, notifications } = setup({
        startedBy: user.id,
        assignment: user.id,
      });
      await expect(
        service.decide(user, 'task-1', { decision, reason: 'Looks wrong' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You cannot decide a review for a creative you submitted',
        ),
      );
      expect(tx.approvalDecision.create).not.toHaveBeenCalled();
      expect(tx.workflowTask.updateMany).not.toHaveBeenCalled();
      expect(tx.changeRequest.create).not.toHaveBeenCalled();
      expect(workflows.transitionInTransaction).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    },
  );

  it('refuses the submitter even when the task is assigned by a permission they hold', async () => {
    const { service, tx } = setup({ startedBy: user.id, assignment: null });
    tx.workflowTask.findFirst.mockResolvedValue({
      ...(await tx.workflowTask.findFirst()),
      requiredPermission: PERMISSIONS.APPROVAL_DECIDE,
    });
    await expect(
      service.decide(user, 'task-1', { decision: ReviewDecisionType.APPROVED }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.approvalDecision.create).not.toHaveBeenCalled();
  });

  // Stage 10.6: an approval may only move a longer workflow to its next
  // review, so the decision itself announces nothing. The transition that
  // completes an all-approved run sends "Creative approved" (covered in
  // workflows.service.spec.ts).
  it('leaves the approval notice to the transition, which runs in the same transaction', async () => {
    const { service, notifications, tx, workflows } = setup();
    await service.decide(user, 'task-1', {
      decision: ReviewDecisionType.APPROVED,
    });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(workflows.transitionInTransaction).toHaveBeenCalledWith(
      tx,
      user,
      'instance-1',
      'approve',
      undefined,
      PERMISSIONS.APPROVAL_DECIDE,
    );
  });

  it('announces changes requested once, through the change request', async () => {
    const { service, notifications, tx } = setup();
    await service.decide(user, 'task-1', {
      decision: ReviewDecisionType.CHANGES_REQUESTED,
      reason: 'Update the offer',
    });
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        recipientUserId: 'submitter-1',
        type: 'CHANGE_REQUEST_CREATED',
      }),
    );
  });

  it('hides runs the caller started from their pending reviews', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      userBranchAccess: {
        findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
      },
      workflowTask: { findMany },
    };
    const service = new ApprovalsService(
      prisma as unknown as PrismaService,
      {} as WorkflowsService,
      { write: vi.fn() } as never,
      { create: vi.fn() } as never,
    );
    await service.pending(user);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          instance: expect.objectContaining({
            startedById: { not: user.id },
          }),
        }),
      }),
    );
  });

  it('tells the client when the viewer submitted the reviewed run', async () => {
    for (const [startedBy, expected] of [
      [user.id, true],
      ['submitter-1', false],
    ] as const) {
      const { tx } = setup({ startedBy });
      const prisma = {
        ...tx,
        creativeRevision: {
          findFirst: vi.fn().mockResolvedValue({ id: 'revision-1' }),
        },
      };
      const service = new ApprovalsService(
        prisma as unknown as PrismaService,
        {} as WorkflowsService,
        { write: vi.fn() } as never,
        { create: vi.fn() } as never,
      );
      await expect(service.context(user, 'task-1')).resolves.toMatchObject({
        submittedByViewer: expected,
      });
    }
  });
});

describe('ApprovalsService comment threads and notifications', () => {
  type StoredComment = { id: string; parentId: string | null };

  // A revision with stored comments, an optional open review task, the
  // latest run's submitter, and open change requests by reviewers.
  function commentSetup(
    options: {
      comments?: StoredComment[];
      activeReviewer?: string | null;
      submitter?: string | null;
      requestCreators?: string[];
    } = {},
  ) {
    const comments = options.comments ?? [];
    const notifications = { create: vi.fn().mockResolvedValue({}) };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const latestRun =
      options.submitter === null
        ? null
        : { id: 'instance-1', startedById: options.submitter ?? 'submitter-1' };
    const tx = {
      creativeComment: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'comment-new',
          ...data,
        })),
      },
      workflowTask: {
        findFirst: vi.fn().mockResolvedValue(
          options.activeReviewer === undefined || options.activeReviewer
            ? {
                id: 'task-1',
                assignedUserId: options.activeReviewer ?? 'reviewer-1',
                instanceId: 'instance-1',
              }
            : null,
        ),
      },
      workflowInstance: {
        findFirst: vi.fn().mockResolvedValue(latestRun),
      },
      changeRequest: {
        findMany: vi.fn().mockResolvedValue(
          (options.requestCreators ?? []).map((createdById, index) => ({
            id: 'request-' + index,
            createdById,
            workflowInstanceId: 'instance-1',
          })),
        ),
      },
    };
    const prisma = {
      creative: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'creative-1',
          branchId: 'branch-1',
          name: 'Spring post',
        }),
      },
      creativeRevision: {
        findUnique: vi.fn().mockResolvedValue({ id: 'revision-1' }),
      },
      creativeComment: {
        findFirst: vi.fn(
          async ({ where }: { where: { id: string } }) =>
            comments.find((comment) => comment.id === where.id) ?? null,
        ),
      },
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new ApprovalsService(
      prisma as unknown as PrismaService,
      {} as WorkflowsService,
      audit as never,
      notifications as never,
    );
    return { service, prisma, tx, audit, notifications };
  }

  it('starts a new thread for a comment without a parent', async () => {
    const { service, tx } = commentSetup();
    await service.addComment(user, 'creative-1', 1, '  Please fix the logo ');
    expect(tx.creativeComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentId: null,
          text: 'Please fix the logo',
        }),
      }),
    );
  });

  it('attaches a reply to a top-level comment directly', async () => {
    const { service, tx, audit } = commentSetup({
      comments: [{ id: 'root', parentId: null }],
    });
    await service.addComment(user, 'creative-1', 1, 'Done', 'root');
    expect(tx.creativeComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'root' }),
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'comment.created',
        metadata: { revisionNumber: 1, parentId: 'root' },
      }),
    );
  });

  it('attaches a reply to a reply to the original top-level comment', async () => {
    const { service, tx, audit } = commentSetup({
      comments: [
        { id: 'root', parentId: null },
        { id: 'reply-1', parentId: 'root' },
      ],
    });
    await service.addComment(user, 'creative-1', 1, 'Agreed', 'reply-1');
    expect(tx.creativeComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'root' }),
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        metadata: {
          revisionNumber: 1,
          parentId: 'root',
          repliedToCommentId: 'reply-1',
        },
      }),
    );
  });

  it('follows older, deeper reply chains up to their top-level comment', async () => {
    const { service, tx } = commentSetup({
      comments: [
        { id: 'root', parentId: null },
        { id: 'reply-1', parentId: 'root' },
        { id: 'reply-2', parentId: 'reply-1' },
      ],
    });
    await service.addComment(user, 'creative-1', 1, 'Agreed', 'reply-2');
    expect(tx.creativeComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'root' }),
      }),
    );
  });

  it('scopes every parent lookup to the same creative, revision and organization', async () => {
    const { service, prisma } = commentSetup({
      comments: [{ id: 'root', parentId: null }],
    });
    await service.addComment(user, 'creative-1', 1, 'Done', 'root');
    expect(prisma.creativeComment.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'root',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-1',
        organizationId: 'org-1',
      },
      select: { id: true, parentId: true },
    });
  });

  it('rejects a reply whose thread cannot be found without writing anything', async () => {
    const { service, tx, audit } = commentSetup({
      comments: [{ id: 'reply-1', parentId: 'missing-root' }],
    });
    await expect(
      service.addComment(user, 'creative-1', 1, 'Agreed', 'reply-1'),
    ).rejects.toThrow('Comment thread not found');
    expect(tx.creativeComment.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('words notifications for the submitter and for reviewers', async () => {
    const author = { ...user, id: 'commenter-1', name: 'Rita Reviewer' };
    const { service, notifications, tx } = commentSetup({
      activeReviewer: 'reviewer-2',
      requestCreators: ['reviewer-3'],
    });
    await service.addComment(author, 'creative-1', 2, 'Tighten the copy');
    const sent = notifications.create.mock.calls.map(
      ([, notification]) => notification as Record<string, string>,
    );
    expect(sent.map((item) => item.recipientUserId).sort()).toEqual([
      'reviewer-2',
      'reviewer-3',
      'submitter-1',
    ]);
    expect(sent.find((item) => item.recipientUserId === 'submitter-1')).toEqual(
      expect.objectContaining({
        title: 'New comment on your creative',
        message:
          'Rita Reviewer commented on revision 2 of Spring post, which you submitted for review.',
      }),
    );
    expect(sent.find((item) => item.recipientUserId === 'reviewer-2')).toEqual(
      expect.objectContaining({
        title: 'New review comment',
        message:
          'Rita Reviewer commented on revision 2 of Spring post, which you are reviewing or reviewed.',
      }),
    );
    expect(tx.workflowInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          creativeId: 'creative-1',
          creativeRevisionId: 'revision-1',
        },
      }),
    );
  });

  it('still notifies the submitter after the review task has closed', async () => {
    const { service, notifications } = commentSetup({ activeReviewer: null });
    await service.addComment(user, 'creative-1', 1, 'One more thing');
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipientUserId: 'submitter-1',
        title: 'New comment on your creative',
        workflowInstanceId: 'instance-1',
      }),
    );
  });

  it('does not notify the author of their own comment', async () => {
    const { service, notifications } = commentSetup({
      activeReviewer: null,
      submitter: user.id,
      requestCreators: [user.id],
    });
    await service.addComment(user, 'creative-1', 1, 'Note to self');
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

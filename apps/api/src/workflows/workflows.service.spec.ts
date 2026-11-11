import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
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

describe('WorkflowsService resubmission', () => {
  type StoredRequest = {
    id: string;
    status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED';
    revisionNumber: number;
    createdById: string;
  };

  // Starts a run for revision `revisionNumber` of creative-1. The change
  // request store applies the service's filters, so a test sees exactly which
  // requests the run answers.
  function startSetup(
    options: {
      revisionNumber?: number;
      requests?: StoredRequest[];
      activeRun?: boolean;
      lostUpdate?: boolean;
      // Where the enabled version's changes-requested transition leads.
      changesRequestedTo?: 'stage-changes' | 'stage-review';
    } = {},
  ) {
    const requests = options.requests ?? [];
    const stage = (id: string, key: string, extra: object = {}) => ({
      id,
      key,
      name: key,
      displayOrder: id.length,
      isEntry: false,
      isTerminal: false,
      requiresReview: false,
      requiredPermission: null,
      assignedUserId: null,
      assignedPermission: null,
      ...extra,
    });
    const reviewTransition = (
      key: string,
      destinationStageId: string,
      reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED',
    ) => ({
      key,
      label: key,
      sourceStageId: 'stage-review',
      destinationStageId,
      requiredPermission: null,
      reviewDecision,
    });
    const tx = {
      creative: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'creative-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          name: 'Spring post',
          currentRevisionId: 'revision-current',
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      workflowInstance: {
        findFirst: vi
          .fn()
          .mockResolvedValue(options.activeRun ? { id: 'running' } : null),
        create: vi.fn().mockResolvedValue({ id: 'instance-2' }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'instance-2' }),
      },
      workflow: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'workflow-1',
          name: 'Spring review',
          description: null,
          enabledVersionNumber: 1,
        }),
      },
      workflowVersion: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'version-1',
          immutableAt: new Date(),
          stages: [
            stage('stage-review', 'review', {
              isEntry: true,
              requiresReview: true,
              assignedPermission: PERMISSIONS.APPROVAL_DECIDE,
            }),
            stage('stage-approved', 'approved', { isTerminal: true }),
            stage('stage-changes', 'changes', {
              isTerminal: options.changesRequestedTo !== 'stage-review',
            }),
          ],
          transitions: [
            reviewTransition('approve', 'stage-approved', 'APPROVED'),
            reviewTransition(
              'request_changes',
              options.changesRequestedTo ?? 'stage-changes',
              'CHANGES_REQUESTED',
            ),
          ],
        }),
      },
      creativeRevision: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'revision-current',
          revisionNumber: options.revisionNumber ?? 2,
        }),
      },
      workflowTransitionHistory: { create: vi.fn().mockResolvedValue({}) },
      workflowTask: {
        create: vi
          .fn()
          .mockResolvedValue({ id: 'task-2', assignedUserId: null }),
      },
      changeRequest: {
        // Unresolved requests on one revision. The current revision is
        // 'revision-current'; other requests sit on 'revision-<number>'.
        count: vi.fn(
          async ({
            where,
          }: {
            where: { creativeRevisionId: string; status: { in: string[] } };
          }) =>
            requests.filter(
              (request) =>
                where.status.in.includes(request.status) &&
                (where.creativeRevisionId === 'revision-current'
                  ? request.revisionNumber === (options.revisionNumber ?? 2)
                  : where.creativeRevisionId ===
                    'revision-' + request.revisionNumber),
            ).length,
        ),
        findMany: vi.fn(
          async ({
            where,
          }: {
            where: {
              status: { in: string[] };
              revisionNumber: { lt: number };
            };
          }) =>
            requests
              .filter(
                (request) =>
                  where.status.in.includes(request.status) &&
                  request.revisionNumber < where.revisionNumber.lt,
              )
              .map((request) => ({
                ...request,
                creativeRevisionId: 'revision-' + request.revisionNumber,
                workflowInstanceId: 'instance-1',
              })),
        ),
        updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
          if (options.lostUpdate) return { count: 0 };
          const request = requests.find((item) => item.id === where.id);
          if (request) request.status = 'RESOLVED';
          return { count: request ? 1 : 0 };
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const notifications = { create: vi.fn().mockResolvedValue({}) };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      audit as never,
      notifications as never,
    );
    return { service, tx, audit, notifications, requests };
  }

  it('resolves open and in-progress requests from older revisions when a newer revision starts a run', async () => {
    const { service, tx, audit, notifications, requests } = startSetup({
      revisionNumber: 3,
      requests: [
        {
          id: 'request-1',
          status: 'OPEN',
          revisionNumber: 1,
          createdById: 'reviewer-1',
        },
        {
          id: 'request-2',
          status: 'IN_PROGRESS',
          revisionNumber: 2,
          createdById: 'reviewer-2',
        },
        {
          id: 'request-old',
          status: 'CANCELLED',
          revisionNumber: 1,
          createdById: 'reviewer-1',
        },
      ],
    });
    await service.start(principal, 'creative-1', 'workflow-1');
    expect(requests.map((request) => request.status)).toEqual([
      'RESOLVED',
      'RESOLVED',
      'CANCELLED',
    ]);
    expect(tx.changeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', status: { in: ['OPEN', 'IN_PROGRESS'] } },
      data: {
        status: 'RESOLVED',
        resolvedById: principal.id,
        resolvedAt: expect.any(Date),
      },
    });
    // Resolution happens only after the run, its task and its audit exist.
    expect(tx.workflowInstance.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.changeRequest.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'change_request.resolved',
        entityId: 'request-2',
        changeRequestId: 'request-2',
        creativeRevisionId: 'revision-2',
        workflowInstanceId: 'instance-1',
        metadata: expect.objectContaining({
          previousStatus: 'IN_PROGRESS',
          resolution: 'RESUBMITTED',
          revisionNumber: 2,
          resubmittedRevisionNumber: 3,
          resubmittedWorkflowInstanceId: 'instance-2',
        }),
      }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        recipientUserId: 'reviewer-1',
        title: 'Creative resubmitted',
        message:
          'Spring post was resubmitted as revision 3, resolving your change request on revision 1.',
      }),
    );
  });

  // Stage 10.6: a run for the same revision would show the reviewer the
  // revision they already asked to change.
  describe('unresolved change requests on the same revision', () => {
    const onRevision = (
      status: StoredRequest['status'],
      revisionNumber = 2,
    ): StoredRequest => ({
      id: 'request-1',
      status,
      revisionNumber,
      createdById: 'reviewer-1',
    });

    it.each(['OPEN', 'IN_PROGRESS'] as const)(
      'refuses a run while the current revision has an %s request, with 409 and no writes',
      async (status) => {
        const { service, tx, audit, requests } = startSetup({
          revisionNumber: 2,
          requests: [onRevision(status)],
        });
        const attempt = service.start(principal, 'creative-1', 'workflow-1');
        await expect(attempt).rejects.toBeInstanceOf(ConflictException);
        await expect(attempt).rejects.toThrow(
          'Save a new revision with the requested changes before resubmitting.',
        );
        expect(tx.changeRequest.count).toHaveBeenCalledWith({
          where: {
            organizationId: 'org-1',
            creativeRevisionId: 'revision-current',
            status: { in: ['OPEN', 'IN_PROGRESS'] },
          },
        });
        expect(tx.workflowInstance.create).not.toHaveBeenCalled();
        expect(tx.creative.update).not.toHaveBeenCalled();
        expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
        expect(audit.write).not.toHaveBeenCalled();
        expect(requests[0]!.status).toBe(status);
      },
    );

    it.each(['RESOLVED', 'CANCELLED'] as const)(
      'allows a run when the current revision request is %s, and leaves it alone',
      async (status) => {
        const { service, tx, requests } = startSetup({
          revisionNumber: 2,
          requests: [onRevision(status)],
        });
        await service.start(principal, 'creative-1', 'workflow-1');
        expect(tx.workflowInstance.create).toHaveBeenCalledTimes(1);
        expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
        expect(requests[0]!.status).toBe(status);
      },
    );

    it('is not blocked by an unresolved request on an older revision, which the run resolves', async () => {
      const { service, tx, requests } = startSetup({
        revisionNumber: 3,
        requests: [onRevision('OPEN', 2)],
      });
      await service.start(principal, 'creative-1', 'workflow-1');
      expect(tx.workflowInstance.create).toHaveBeenCalledTimes(1);
      expect(requests[0]!.status).toBe('RESOLVED');
    });

    it('checks branch access before looking at change requests', async () => {
      const { service, tx } = startSetup({
        revisionNumber: 2,
        requests: [onRevision('OPEN')],
      });
      tx.userBranchAccess.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.start(principal, 'creative-1', 'workflow-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.changeRequest.count).not.toHaveBeenCalled();
    });
  });

  it('refuses to start a run from an enabled version that fails the current rules', async () => {
    // A version enabled before changes-requested routes had to finish
    // without another review: its run would leave the creative locked.
    const { service, tx, audit, requests } = startSetup({
      revisionNumber: 3,
      changesRequestedTo: 'stage-review',
      requests: [
        {
          id: 'request-1',
          status: 'OPEN',
          revisionNumber: 2,
          createdById: 'reviewer-1',
        },
      ],
    });
    const attempt = service.start(principal, 'creative-1', 'workflow-1');
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(
      /cannot start new runs until it is updated and enabled again: .*Changes-requested transition request_changes leads to stage review/,
    );
    expect(tx.workflowInstance.create).not.toHaveBeenCalled();
    expect(tx.creative.update).not.toHaveBeenCalled();
    expect(tx.workflowTask.create).not.toHaveBeenCalled();
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
    expect(requests[0]!.status).toBe('OPEN');
  });

  it('refuses to start from an enabled version whose review stage cannot request changes, without changing it', async () => {
    // Versions enabled before Stage 10.1 may have only an approval route.
    const { service, tx, audit } = startSetup();
    const stored = await tx.workflowVersion.findUnique();
    const version = {
      ...stored,
      stages: stored.stages.filter(
        (stage: { key: string }) => stage.key !== 'changes',
      ),
      transitions: stored.transitions.filter(
        (transition: { key: string }) => transition.key === 'approve',
      ),
    };
    tx.workflowVersion.findUnique.mockReset().mockResolvedValue(version);
    const attempt = service.start(principal, 'creative-1', 'workflow-1');
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(
      'Workflow Spring review cannot start new runs until it is updated and enabled again: Review stage review requires one CHANGES_REQUESTED transition.',
    );
    expect(tx.workflowInstance.create).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
    // The stored definition is only read, never rewritten.
    expect(version.transitions).toHaveLength(1);
  });

  it('loads the enabled version transitions so the start can validate them', async () => {
    const { service, tx } = startSetup();
    await service.start(principal, 'creative-1', 'workflow-1');
    expect(tx.workflowVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { stages: true, transitions: true },
      }),
    );
    expect(tx.workflowInstance.create).toHaveBeenCalledTimes(1);
  });

  describe('current revision only', () => {
    // revision-current is number 3; revision-old is number 1.
    const withRevisions = (setup: ReturnType<typeof startSetup>) => {
      setup.tx.creativeRevision.findFirst.mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === 'revision-current'
            ? { id: 'revision-current', revisionNumber: 3 }
            : where.id === 'revision-old'
              ? { id: 'revision-old', revisionNumber: 1 }
              : null,
      );
      return setup;
    };
    const expectNothingWritten = (
      tx: ReturnType<typeof startSetup>['tx'],
      audit: ReturnType<typeof startSetup>['audit'],
    ) => {
      expect(tx.workflowInstance.create).not.toHaveBeenCalled();
      expect(tx.creative.update).not.toHaveBeenCalled();
      expect(tx.workflowTask.create).not.toHaveBeenCalled();
      expect(tx.workflowTransitionHistory.create).not.toHaveBeenCalled();
      expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    };

    it('starts a run for the current revision when it is named explicitly', async () => {
      const { service, tx } = withRevisions(startSetup());
      await service.start(
        principal,
        'creative-1',
        'workflow-1',
        'revision-current',
      );
      expect(tx.workflowInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            creativeRevisionId: 'revision-current',
          }),
        }),
      );
    });

    it('refuses an older revision with 409, naming both revision numbers, and writes nothing', async () => {
      const { service, tx, audit } = withRevisions(startSetup());
      const attempt = service.start(
        principal,
        'creative-1',
        'workflow-1',
        'revision-old',
      );
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(
        'Only the current revision (3) can be submitted for review; revision 1 is an older revision',
      );
      expectNothingWritten(tx, audit);
    });

    it('keeps refusing a revision of another creative with 400', async () => {
      const { service, tx, audit } = withRevisions(startSetup());
      await expect(
        service.start(principal, 'creative-1', 'workflow-1', 'revision-x'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expectNothingWritten(tx, audit);
    });

    it('refuses a creative without a current revision with 409 before looking up any revision', async () => {
      const { service, tx, audit } = withRevisions(startSetup());
      tx.creative.findFirst.mockResolvedValueOnce({
        id: 'creative-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        name: 'Spring post',
        currentRevisionId: null,
      });
      const attempt = service.start(principal, 'creative-1', 'workflow-1');
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(
        'Creative has no current revision to submit; save a revision first',
      );
      expect(tx.creativeRevision.findFirst).not.toHaveBeenCalled();
      expectNothingWritten(tx, audit);
    });

    it('defaults to the current revision when none is named', async () => {
      const { service, tx } = withRevisions(startSetup());
      await service.start(principal, 'creative-1', 'workflow-1');
      expect(tx.creativeRevision.findFirst).toHaveBeenCalledWith({
        where: { id: 'revision-current', creativeId: 'creative-1' },
      });
      expect(tx.workflowInstance.create).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves requests open when the run cannot be created', async () => {
    const { service, tx, requests } = startSetup({
      revisionNumber: 3,
      activeRun: true,
      requests: [
        {
          id: 'request-1',
          status: 'OPEN',
          revisionNumber: 2,
          createdById: 'reviewer-1',
        },
      ],
    });
    await expect(
      service.start(principal, 'creative-1', 'workflow-1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(requests[0]!.status).toBe('OPEN');
    expect(tx.changeRequest.findMany).not.toHaveBeenCalled();
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('fails the whole start when a request changed concurrently', async () => {
    const { service, audit } = startSetup({
      revisionNumber: 3,
      lostUpdate: true,
      requests: [
        {
          id: 'request-1',
          status: 'OPEN',
          revisionNumber: 2,
          createdById: 'reviewer-1',
        },
      ],
    });
    await expect(
      service.start(principal, 'creative-1', 'workflow-1'),
    ).rejects.toThrow('Workflow changed concurrently; reload and retry');
    expect(audit.write).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'change_request.resolved' }),
    );
  });

  it('does not notify the person who resubmitted about their own request', async () => {
    const { service, notifications } = startSetup({
      revisionNumber: 3,
      requests: [
        {
          id: 'request-1',
          status: 'OPEN',
          revisionNumber: 2,
          createdById: principal.id,
        },
      ],
    });
    await service.start(principal, 'creative-1', 'workflow-1');
    expect(notifications.create).not.toHaveBeenCalled();
  });
});

// Stage 10.3: cancelling a RUNNING run so a stuck creative can recover.
describe('WorkflowsService cancellation', () => {
  const as = (
    id: string,
    permissions: string[],
    extra: Partial<AuthenticatedPrincipal> = {},
  ): AuthenticatedPrincipal => ({
    ...principal,
    id,
    name: id === 'manager-1' ? 'Mona Manager' : 'Operator',
    permissions,
    ...extra,
  });
  const manager = as('manager-1', [
    PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.WORKFLOW_MANAGE,
  ]);
  // user-1 started the run.
  const starter = as('user-1', [
    PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.WORKFLOW_START,
  ]);
  const otherStarter = as('user-2', [
    PERMISSIONS.WORKFLOW_READ,
    PERMISSIONS.WORKFLOW_START,
  ]);

  function cancelSetup(
    options: {
      status?: string;
      decisions?: number;
      branchGranted?: boolean;
      organizationId?: string;
      taskAssignee?: string | null;
      // Simulates a commit by another request between the read and the
      // guarded update.
      concurrent?: 'decision' | 'transition' | 'cancel';
    } = {},
  ) {
    const run = {
      id: 'instance-1',
      organizationId: options.organizationId ?? 'org-1',
      branchId: 'branch-1',
      creativeId: 'creative-1',
      creativeRevisionId: 'revision-2',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      currentStageId: 'stage-review',
      status: options.status ?? 'RUNNING',
      startedById: 'user-1',
      completedAt: null as Date | null,
      currentStage: {
        id: 'stage-review',
        key: 'review',
        name: 'Review',
      },
      workflow: { id: 'workflow-1', name: 'Spring review' },
      creative: { id: 'creative-1', name: 'Spring post' },
    };
    const decisions = Array.from(
      { length: options.decisions ?? 0 },
      (_, i) => ({
        id: 'decision-' + i,
        decision: 'APPROVED',
      }),
    );
    const tasks = [
      {
        id: 'task-1',
        instanceId: 'instance-1',
        status: 'OPEN',
        assignedUserId:
          options.taskAssignee === undefined
            ? 'reviewer-1'
            : options.taskAssignee,
      },
      {
        id: 'task-0',
        instanceId: 'instance-1',
        status: 'COMPLETED',
        assignedUserId: 'reviewer-0',
      },
    ];
    const requests = [{ id: 'request-1', status: 'OPEN' }];
    const tx = {
      workflowInstance: {
        findFirst: vi.fn(
          async ({
            where,
          }: {
            where: { id: string; organizationId: string };
          }) =>
            where.id === run.id && where.organizationId === run.organizationId
              ? { ...run }
              : null,
        ),
        updateMany: vi.fn(
          async ({
            where,
            data,
          }: {
            where: { status: string; currentStageId: string };
            data: { status: string; completedAt: Date };
          }) => {
            if (options.concurrent === 'decision') run.status = 'COMPLETED';
            if (options.concurrent === 'transition')
              run.currentStageId = 'stage-legal';
            if (options.concurrent === 'cancel') run.status = 'CANCELLED';
            if (
              run.status !== where.status ||
              run.currentStageId !== where.currentStageId
            )
              return { count: 0 };
            run.status = data.status;
            run.completedAt = data.completedAt;
            return { count: 1 };
          },
        ),
        findUniqueOrThrow: vi.fn(async () => ({ ...run })),
      },
      userBranchAccess: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            options.branchGranted === false ? null : { branchId: 'branch-1' },
          ),
      },
      approvalDecision: {
        count: vi.fn(async () => decisions.length),
      },
      workflowTask: {
        findMany: vi.fn(async () =>
          tasks
            .filter((task) => task.status === 'OPEN')
            .map(({ assignedUserId }) => ({ assignedUserId })),
        ),
        updateMany: vi.fn(async ({ data }: { data: { status: string } }) => {
          let count = 0;
          for (const task of tasks)
            if (task.status === 'OPEN') {
              task.status = data.status;
              count += 1;
            }
          return { count };
        }),
      },
      workflowTransitionHistory: { create: vi.fn().mockResolvedValue({}) },
      creative: { update: vi.fn().mockResolvedValue({}) },
      changeRequest: { updateMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const notifications = { create: vi.fn().mockResolvedValue({}) };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      audit as never,
      notifications as never,
    );
    return {
      service,
      tx,
      audit,
      notifications,
      run,
      tasks,
      decisions,
      requests,
    };
  }
  const expectNothingWritten = (setup: ReturnType<typeof cancelSetup>) => {
    expect(setup.tx.workflowTask.updateMany).not.toHaveBeenCalled();
    expect(setup.tx.workflowTransitionHistory.create).not.toHaveBeenCalled();
    expect(setup.tx.creative.update).not.toHaveBeenCalled();
    expect(setup.audit.write).not.toHaveBeenCalled();
    expect(setup.notifications.create).not.toHaveBeenCalled();
  };

  it('lets a workflow manager cancel, staling open tasks and recording history, audit and DRAFT', async () => {
    const setup = cancelSetup({ decisions: 1 });
    const { service, tx, audit, run, tasks, decisions, requests } = setup;
    const result = await service.cancel(
      manager,
      'instance-1',
      '  Reviewer left the company  ',
    );
    expect(result.status).toBe('CANCELLED');
    expect(run.completedAt).toBeInstanceOf(Date);
    expect(tx.workflowInstance.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'instance-1',
        status: 'RUNNING',
        currentStageId: 'stage-review',
      },
      data: { status: 'CANCELLED', completedAt: expect.any(Date) },
    });
    // Only the open task goes stale; the completed one is untouched.
    expect(tasks.map((task) => task.status)).toEqual(['STALE', 'COMPLETED']);
    expect(tx.workflowTransitionHistory.create).toHaveBeenCalledWith({
      data: {
        instanceId: 'instance-1',
        versionId: 'version-1',
        fromStageId: 'stage-review',
        toStageId: 'stage-review',
        actorId: 'manager-1',
        actionKey: 'CANCEL',
        reason: 'Reviewer left the company',
      },
    });
    expect(tx.creative.update).toHaveBeenCalledWith({
      where: { id: 'creative-1' },
      data: { status: 'DRAFT' },
    });
    expect(audit.write).toHaveBeenCalledWith(tx, {
      organizationId: 'org-1',
      actorUserId: 'manager-1',
      action: 'workflow.cancelled',
      entityType: 'workflow_instance',
      entityId: 'instance-1',
      branchId: 'branch-1',
      creativeId: 'creative-1',
      creativeRevisionId: 'revision-2',
      workflowInstanceId: 'instance-1',
      metadata: {
        workflowId: 'workflow-1',
        previousStage: 'review',
        reason: 'Reviewer left the company',
        cancelledAs: 'WORKFLOW_MANAGER',
        staleTaskCount: 1,
      },
    });
    // Decisions and change requests are neither changed nor resolved.
    expect(decisions).toHaveLength(1);
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
    expect(requests[0]!.status).toBe('OPEN');
  });

  it('never sends a Creative approved notice, even after an approval decision', async () => {
    const { service, notifications } = cancelSetup({ decisions: 1 });
    await service.cancel(manager, 'instance-1', 'Stuck');
    const types = notifications.create.mock.calls.map(
      ([, input]) => (input as { type: string }).type,
    );
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((type) => type === 'WORKFLOW_CANCELLED')).toBe(true);
  });

  it('notifies the starter and the open task assignee once each, never the canceller', async () => {
    const { service, notifications } = cancelSetup();
    await service.cancel(manager, 'instance-1', 'Stuck');
    const recipients = notifications.create.mock.calls.map(
      ([, input]) => (input as { recipientUserId: string }).recipientUserId,
    );
    expect(recipients.sort()).toEqual(['reviewer-1', 'user-1']);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipientUserId: 'user-1',
        eventKey: 'workflow-cancelled:instance-1',
        type: 'WORKFLOW_CANCELLED',
        title: 'Workflow cancelled',
        message:
          'Mona Manager cancelled the Spring review run for Spring post at the Review stage: Stuck',
        workflowInstanceId: 'instance-1',
      }),
    );
  });

  it('does not notify a canceller who is also the starter or the assignee', async () => {
    const { service, notifications } = cancelSetup({ taskAssignee: 'user-1' });
    await service.cancel(starter, 'instance-1', 'Submitted by mistake');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('lets the starter cancel before any decision, recorded as the starter', async () => {
    const { service, audit, run } = cancelSetup();
    await service.cancel(starter, 'instance-1', 'Submitted by mistake');
    expect(run.status).toBe('CANCELLED');
    expect(audit.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ cancelledAs: 'STARTER' }),
      }),
    );
  });

  it('refuses the starter once a decision is recorded, with 403 and no writes', async () => {
    const setup = cancelSetup({ decisions: 1 });
    await expect(
      setup.service.cancel(starter, 'instance-1', 'Too late'),
    ).rejects.toThrow(
      'A review decision has been recorded in this run; only a workflow manager can cancel it now',
    );
    expect(setup.run.status).toBe('RUNNING');
    expect(setup.tx.workflowInstance.updateMany).not.toHaveBeenCalled();
    expectNothingWritten(setup);
  });

  it('refuses another user who can start workflows but did not start this run', async () => {
    const setup = cancelSetup();
    const attempt = setup.service.cancel(otherStarter, 'instance-1', 'Mine?');
    await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt).rejects.toThrow(
      'Only a workflow manager or the person who started this run can cancel it',
    );
    expect(setup.tx.approvalDecision.count).not.toHaveBeenCalled();
    expectNothingWritten(setup);
  });

  it('refuses a user with neither workflows:manage nor workflows:start before any lookup', async () => {
    const setup = cancelSetup();
    await expect(
      setup.service.cancel(
        as('user-1', [
          PERMISSIONS.WORKFLOW_READ,
          PERMISSIONS.WORKFLOW_TRANSITION,
        ]),
        'instance-1',
        'Stuck',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(setup.tx.workflowInstance.findFirst).not.toHaveBeenCalled();
  });

  it('hides a run in a branch the caller cannot access with 404, even for a manager', async () => {
    const setup = cancelSetup({ branchGranted: false });
    await expect(
      setup.service.cancel(manager, 'instance-1', 'Stuck'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(setup.tx.workflowInstance.updateMany).not.toHaveBeenCalled();
    expectNothingWritten(setup);
  });

  it('hides a run of another organization with 404', async () => {
    const setup = cancelSetup({ organizationId: 'org-2' });
    const attempt = setup.service.cancel(manager, 'instance-1', 'Stuck');
    await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    await expect(attempt).rejects.toThrow('Workflow instance not found');
    expect(setup.tx.workflowInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'instance-1', organizationId: 'org-1' },
      }),
    );
    expectNothingWritten(setup);
  });

  it.each(['', '   ', 'x'.repeat(1001)])(
    'requires a reason of 1 to 1000 characters after trimming (%#)',
    async (reason) => {
      const setup = cancelSetup();
      const attempt = setup.service.cancel(manager, 'instance-1', reason);
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(
        'A cancellation reason of 1 to 1000 characters is required',
      );
      expect(setup.tx.workflowInstance.findFirst).not.toHaveBeenCalled();
    },
  );

  it('accepts a reason of exactly 1000 characters', async () => {
    const { service, run } = cancelSetup();
    await service.cancel(manager, 'instance-1', 'x'.repeat(1000));
    expect(run.status).toBe('CANCELLED');
  });

  it.each(['COMPLETED', 'CANCELLED'])(
    'refuses a %s run with 409 and writes nothing',
    async (status) => {
      const setup = cancelSetup({ status });
      const attempt = setup.service.cancel(manager, 'instance-1', 'Again');
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow('Workflow is not running');
      expect(setup.tx.workflowInstance.updateMany).not.toHaveBeenCalled();
      expectNothingWritten(setup);
    },
  );

  it('returns 409 for a second cancellation of the same run', async () => {
    const setup = cancelSetup();
    await setup.service.cancel(manager, 'instance-1', 'First');
    setup.audit.write.mockClear();
    setup.notifications.create.mockClear();
    setup.tx.workflowTask.updateMany.mockClear();
    setup.tx.workflowTransitionHistory.create.mockClear();
    setup.tx.creative.update.mockClear();
    await expect(
      setup.service.cancel(manager, 'instance-1', 'Second'),
    ).rejects.toBeInstanceOf(ConflictException);
    expectNothingWritten(setup);
  });

  it.each(['decision', 'transition', 'cancel'] as const)(
    'fails with 409 and writes nothing when a concurrent %s changed the run first',
    async (concurrent) => {
      const setup = cancelSetup({ concurrent });
      const attempt = setup.service.cancel(manager, 'instance-1', 'Stuck');
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(
        'Workflow changed concurrently; reload and retry',
      );
      expect(setup.tasks[0]!.status).toBe('OPEN');
      expectNothingWritten(setup);
    },
  );

  it('maps a serialization failure to 409 through the shared transaction helper', async () => {
    const setup = cancelSetup();
    const prisma = {
      $transaction: vi.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError('serialization', {
          code: 'P2034',
          clientVersion: 'test',
        });
      }),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      setup.audit as never,
      setup.notifications as never,
    );
    await expect(
      service.cancel(manager, 'instance-1', 'Stuck'),
    ).rejects.toThrow('Workflow changed concurrently; reload and retry');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  // Regression (Stage 10 PostgreSQL run): a decision queued ahead of a
  // cancellation deadlocked with it; PostgreSQL aborted the cancellation and
  // Prisma reported it as an unknown request error, which was a 500.
  it('maps a deadlock reported as an unknown request error to 409', async () => {
    const setup = cancelSetup();
    const deadlock = new Prisma.PrismaClientUnknownRequestError(
      'Invalid `tx.workflowTask.updateMany()` invocation: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR" }) })',
      { clientVersion: 'test' },
    );
    const prisma = {
      $transaction: vi.fn(async () => {
        throw deadlock;
      }),
    };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      setup.audit as never,
      setup.notifications as never,
    );
    const attempt = service.cancel(manager, 'instance-1', 'Stuck');
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(
      'Workflow changed concurrently; reload and retry',
    );
  });

  it('still rethrows unknown request errors that are not rollbacks', async () => {
    const setup = cancelSetup();
    const other = new Prisma.PrismaClientUnknownRequestError(
      'connection reset',
      { clientVersion: 'test' },
    );
    const service = new WorkflowsService(
      {
        $transaction: vi.fn(async () => {
          throw other;
        }),
      } as unknown as PrismaService,
      setup.audit as never,
      setup.notifications as never,
    );
    await expect(service.cancel(manager, 'instance-1', 'Stuck')).rejects.toBe(
      other,
    );
  });

  it('includes the decision count on run responses so the screen knows if the starter may cancel', async () => {
    const { service, tx } = cancelSetup();
    await service.cancel(manager, 'instance-1', 'Stuck');
    expect(tx.workflowInstance.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: { select: { approvalDecisions: true } },
        }),
      }),
    );
  });
});

// Stage 10.6: no review of a revision with unanswered change requests, and
// "Creative approved" only once the whole run has approved the revision.
describe('WorkflowsService review entry and final approval notice', () => {
  const reviewer = {
    ...principal,
    id: 'reviewer-2',
    name: 'Lena Legal',
    permissions: [PERMISSIONS.APPROVAL_DECIDE, PERMISSIONS.WORKFLOW_TRANSITION],
  };
  type Decision = {
    id: string;
    decision: 'APPROVED' | 'CHANGES_REQUESTED';
    revisionNumber: number;
    reviewer: { name: string };
  };
  const approval = (id: string, name: string): Decision => ({
    id,
    decision: 'APPROVED',
    revisionNumber: 4,
    reviewer: { name },
  });

  function transitionSetup(
    options: {
      from?: { requiresReview: boolean };
      to?: {
        key: string;
        name: string;
        requiresReview?: boolean;
        isTerminal?: boolean;
      };
      unresolved?: number;
      // Newest first, as the service orders them.
      decisions?: Decision[];
      startedById?: string;
    } = {},
  ) {
    const destination = {
      id: 'stage-next',
      requiredPermission: null,
      assignedUserId: null,
      assignedPermission: null,
      requiresReview: false,
      isTerminal: false,
      ...(options.to ?? { key: 'ready', name: 'Ready' }),
    };
    const tx = {
      workflowInstance: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'instance-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          creativeId: 'creative-1',
          creativeRevisionId: 'revision-4',
          status: 'RUNNING',
          startedById: options.startedById ?? 'submitter-1',
          currentStageId: 'stage-current',
          currentStage: {
            key: 'current',
            requiresReview: options.from?.requiresReview ?? false,
            requiredPermission: null,
            assignedUserId: null,
            assignedPermission: null,
          },
          workflowVersionId: 'version-1',
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'instance-1' }),
      },
      userBranchAccess: {
        findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      },
      workflowTransition: {
        findFirst: vi.fn().mockResolvedValue({
          key: 'next',
          destinationStageId: 'stage-next',
          destination,
          requiredPermission: null,
        }),
      },
      changeRequest: {
        count: vi.fn().mockResolvedValue(options.unresolved ?? 0),
      },
      workflowTask: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi
          .fn()
          .mockResolvedValue({ id: 'task-2', assignedUserId: null }),
      },
      workflowTransitionHistory: { create: vi.fn().mockResolvedValue({}) },
      creative: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ name: 'Spring post' }),
      },
      approvalDecision: {
        findMany: vi.fn().mockResolvedValue(options.decisions ?? []),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const notifications = { create: vi.fn().mockResolvedValue({}) };
    const service = new WorkflowsService(
      prisma as unknown as PrismaService,
      audit as never,
      notifications as never,
    );
    // The path decide() takes: inside its transaction, as the reviewer.
    const decide = () =>
      service.transitionInTransaction(
        tx as never,
        reviewer,
        'instance-1',
        'next',
        undefined,
        PERMISSIONS.APPROVAL_DECIDE,
      );
    const approvedNotices = () =>
      notifications.create.mock.calls.filter(
        ([, input]) => (input as { type: string }).type === 'CREATIVE_APPROVED',
      );
    return { service, tx, audit, notifications, decide, approvedNotices };
  }
  const review = { key: 'legal', name: 'Legal review', requiresReview: true };
  const done = { key: 'approved', name: 'Approved', isTerminal: true };

  describe('entering a review stage', () => {
    it('refuses with 409 and writes nothing while the run revision has an unresolved change request', async () => {
      const { service, tx, audit } = transitionSetup({
        to: review,
        unresolved: 1,
      });
      const attempt = service.transition(principal, 'instance-1', 'next');
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toThrow(
        'Revision cannot enter review stage Legal review while it has unresolved change requests. Save a new revision with the requested changes before resubmitting.',
      );
      expect(tx.changeRequest.count).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          creativeRevisionId: 'revision-4',
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
      });
      expect(tx.workflowInstance.updateMany).not.toHaveBeenCalled();
      expect(tx.workflowTask.updateMany).not.toHaveBeenCalled();
      expect(tx.workflowTransitionHistory.create).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('also refuses an approval decision that would lead into a further review', async () => {
      const { decide, tx } = transitionSetup({
        from: { requiresReview: true },
        to: review,
        unresolved: 1,
      });
      await expect(decide()).rejects.toBeInstanceOf(ConflictException);
      expect(tx.workflowInstance.updateMany).not.toHaveBeenCalled();
    });

    it('moves into the review stage once no request is unresolved', async () => {
      const { service, tx } = transitionSetup({ to: review, unresolved: 0 });
      await service.transition(principal, 'instance-1', 'next');
      expect(tx.workflowInstance.updateMany).toHaveBeenCalledTimes(1);
    });

    it('does not check change requests for a non-review destination', async () => {
      const { service, tx } = transitionSetup({ unresolved: 1 });
      await service.transition(principal, 'instance-1', 'next');
      expect(tx.changeRequest.count).not.toHaveBeenCalled();
      expect(tx.workflowInstance.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('"Creative approved" notice', () => {
    it('is not sent by an approval at an intermediate review stage', async () => {
      const { decide, approvedNotices, tx } = transitionSetup({
        from: { requiresReview: true },
        to: review,
        decisions: [approval('decision-1', 'Rita Reviewer')],
      });
      await decide();
      expect(approvedNotices()).toEqual([]);
      expect(tx.approvalDecision.findMany).not.toHaveBeenCalled();
    });

    it('is sent once, by the decision that completes the run, crediting the final reviewer', async () => {
      const { decide, notifications, approvedNotices } = transitionSetup({
        from: { requiresReview: true },
        to: done,
        decisions: [
          approval('decision-2', 'Lena Legal'),
          approval('decision-1', 'Rita Reviewer'),
        ],
      });
      await decide();
      expect(approvedNotices()).toHaveLength(1);
      expect(notifications.create).toHaveBeenCalledWith(expect.anything(), {
        recipientUserId: 'submitter-1',
        organizationId: 'org-1',
        // One key per run: the notification upsert cannot create a second.
        eventKey: 'creative-approved:instance-1',
        type: 'CREATIVE_APPROVED',
        title: 'Creative approved',
        message: 'Lena Legal approved revision 4 of Spring post.',
        entityType: 'approval_decision',
        entityId: 'decision-2',
        branchId: 'branch-1',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-4',
        workflowInstanceId: 'instance-1',
      });
    });

    it('is sent when a later manual transition completes an approved run', async () => {
      const { service, approvedNotices } = transitionSetup({
        to: done,
        decisions: [approval('decision-1', 'Rita Reviewer')],
      });
      await service.transition(principal, 'instance-1', 'next');
      expect(approvedNotices()).toHaveLength(1);
    });

    it('is not sent when the run completes after changes were requested', async () => {
      const { decide, approvedNotices } = transitionSetup({
        from: { requiresReview: true },
        to: { key: 'changes', name: 'Changes', isTerminal: true },
        decisions: [
          {
            id: 'decision-2',
            decision: 'CHANGES_REQUESTED',
            revisionNumber: 4,
            reviewer: { name: 'Lena Legal' },
          },
          approval('decision-1', 'Rita Reviewer'),
        ],
      });
      await decide();
      expect(approvedNotices()).toEqual([]);
    });

    it('is not sent when a run without any review decision completes', async () => {
      const { service, approvedNotices } = transitionSetup({ to: done });
      await service.transition(principal, 'instance-1', 'next');
      expect(approvedNotices()).toEqual([]);
    });

    it('is not sent to a starter who completed the run themselves', async () => {
      const { service, approvedNotices, tx } = transitionSetup({
        to: done,
        startedById: principal.id,
        decisions: [approval('decision-1', 'Rita Reviewer')],
      });
      await service.transition(principal, 'instance-1', 'next');
      expect(approvedNotices()).toEqual([]);
      expect(tx.approvalDecision.findMany).not.toHaveBeenCalled();
    });
  });
});

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

  it('leaves a request open when the run is for the same revision', async () => {
    const { service, tx, requests } = startSetup({
      revisionNumber: 2,
      requests: [
        {
          id: 'request-1',
          status: 'OPEN',
          revisionNumber: 2,
          createdById: 'reviewer-1',
        },
      ],
    });
    await service.start(principal, 'creative-1', 'workflow-1');
    expect(requests[0]!.status).toBe('OPEN');
    expect(tx.changeRequest.updateMany).not.toHaveBeenCalled();
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

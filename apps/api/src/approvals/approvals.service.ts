import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChangeRequestStatus,
  Prisma,
  ReviewDecisionType,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';

type DecisionInput = {
  decision: ReviewDecisionType;
  reason?: string;
  explanation?: string;
};

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflows: WorkflowsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private require(user: AuthenticatedPrincipal, permission: string): void {
    if (!user.permissions.includes(permission))
      throw new ForbiddenException('Permission denied');
  }

  private async transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
      )
        throw new ConflictException(
          'Review changed concurrently; reload and retry',
        );
      throw error;
    }
  }

  private async branchIds(user: AuthenticatedPrincipal): Promise<string[]> {
    if (user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)) {
      const branches = await this.prisma.branch.findMany({
        where: { organizationId: user.organizationId, status: 'ACTIVE' },
        select: { id: true },
      });
      return branches.map(({ id }) => id);
    }
    const access = await this.prisma.userBranchAccess.findMany({
      where: {
        userId: user.id,
        branch: { organizationId: user.organizationId, status: 'ACTIVE' },
      },
      select: { branchId: true },
    });
    return access.map(({ branchId }) => branchId);
  }

  private async assertCreative(
    user: AuthenticatedPrincipal,
    creativeId: string,
  ) {
    const creative = await this.prisma.creative.findFirst({
      where: {
        id: creativeId,
        organizationId: user.organizationId,
        branch: {
          status: 'ACTIVE',
          ...(user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
            ? {}
            : { users: { some: { userId: user.id } } }),
        },
      },
      select: { id: true, branchId: true },
    });
    if (!creative) throw new NotFoundException('Creative not found');
    return creative;
  }

  async pending(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.APPROVAL_READ);
    const branchIds = await this.branchIds(user);
    if (!branchIds.length) return [];
    const tasks = await this.prisma.workflowTask.findMany({
      where: {
        status: 'OPEN',
        stage: { requiresReview: true },
        instance: {
          organizationId: user.organizationId,
          branchId: { in: branchIds },
          status: 'RUNNING',
        },
        OR: [
          { assignedUserId: user.id },
          ...(user.permissions.length
            ? [{ requiredPermission: { in: user.permissions } }]
            : []),
        ],
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        stage: { select: { id: true, key: true, name: true } },
        instance: {
          select: {
            id: true,
            branchId: true,
            currentStageId: true,
            creativeRevisionId: true,
            creative: {
              select: {
                id: true,
                name: true,
                currentRevisionId: true,
                currentRevision: { select: { revisionNumber: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return tasks.filter(
      (task) => task.instance.currentStageId === task.stage.id,
    );
  }

  private async taskContext(
    user: AuthenticatedPrincipal,
    taskId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const task = await db.workflowTask.findFirst({
      where: { id: taskId, instance: { organizationId: user.organizationId } },
      include: {
        stage: true,
        instance: {
          include: {
            creative: {
              include: {
                currentRevision: {
                  include: {
                    templateVersion: {
                      include: { fields: { orderBy: { displayOrder: 'asc' } } },
                    },
                  },
                },
              },
            },
            workflow: { select: { name: true } },
          },
        },
      },
    });
    if (!task) throw new NotFoundException('Review task not found');
    if (
      task.instance.creative.organizationId !== user.organizationId ||
      task.instance.creative.branchId !== task.instance.branchId
    )
      throw new NotFoundException('Review task not found');
    const branch = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? await db.branch.findFirst({
          where: {
            id: task.instance.branchId,
            organizationId: user.organizationId,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      : await db.userBranchAccess.findFirst({
          where: {
            userId: user.id,
            branchId: task.instance.branchId,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    if (!branch) throw new NotFoundException('Review task not found');
    return task;
  }

  private assertReviewer(
    user: AuthenticatedPrincipal,
    task: { assignedUserId: string | null; requiredPermission: string | null },
  ) {
    if (
      (task.assignedUserId && task.assignedUserId === user.id) ||
      (task.requiredPermission &&
        user.permissions.includes(task.requiredPermission))
    )
      return;
    throw new ForbiddenException('Review task is assigned to another reviewer');
  }

  async context(user: AuthenticatedPrincipal, taskId: string) {
    this.require(user, PERMISSIONS.APPROVAL_READ);
    const task = await this.taskContext(user, taskId);
    if (!task.stage.requiresReview)
      throw new NotFoundException('Review task not found');
    this.assertReviewer(user, task);
    const revision = await this.prisma.creativeRevision.findFirst({
      where: {
        id: task.instance.creativeRevisionId,
        creativeId: task.instance.creativeId,
      },
      include: {
        templateVersion: {
          include: { fields: { orderBy: { displayOrder: 'asc' } } },
        },
      },
    });
    if (!revision)
      throw new ConflictException('Review revision is unavailable');
    return {
      task: {
        id: task.id,
        status: task.status,
        stage: { key: task.stage.key, name: task.stage.name },
      },
      workflow: { id: task.instance.id, name: task.instance.workflow.name },
      creative: {
        id: task.instance.creative.id,
        name: task.instance.creative.name,
        branchId: task.instance.branchId,
        currentRevisionId: task.instance.creative.currentRevisionId,
      },
      revision,
      current:
        task.instance.status === 'RUNNING' &&
        task.instance.currentStageId === task.stageId &&
        task.status === 'OPEN' &&
        task.instance.creative.currentRevisionId === revision.id &&
        task.instance.creativeRevisionId === revision.id,
    };
  }

  async decide(
    user: AuthenticatedPrincipal,
    taskId: string,
    input: DecisionInput,
  ) {
    this.require(user, PERMISSIONS.APPROVAL_DECIDE);
    if (input.decision === ReviewDecisionType.CHANGES_REQUESTED) {
      this.require(user, PERMISSIONS.CHANGE_REQUEST_CREATE);
      if (!input.reason?.trim())
        throw new BadRequestException(
          'A reason is required when requesting changes',
        );
    }
    return this.transaction(async (tx) => {
      const task = await this.taskContext(user, taskId, tx);
      this.assertReviewer(user, task);
      if (
        !task.stage.requiresReview ||
        task.status !== 'OPEN' ||
        task.instance.status !== 'RUNNING' ||
        task.instance.currentStageId !== task.stageId
      )
        throw new ConflictException('Review task is no longer active');
      const revision = await tx.creativeRevision.findFirst({
        where: {
          id: task.instance.creativeRevisionId,
          creativeId: task.instance.creativeId,
          creative: { currentRevisionId: task.instance.creativeRevisionId },
        },
        select: { id: true, revisionNumber: true },
      });
      if (!revision)
        throw new ConflictException(
          'Creative revision changed; restart the review',
        );
      const transition = await tx.workflowTransition.findFirst({
        where: {
          versionId: task.instance.workflowVersionId,
          sourceStageId: task.stageId,
          reviewDecision: input.decision,
        },
        select: { key: true },
      });
      if (!transition)
        throw new BadRequestException(
          'No workflow transition is configured for this decision',
        );
      const decision = await tx.approvalDecision.create({
        data: {
          organizationId: user.organizationId,
          branchId: task.instance.branchId,
          creativeId: task.instance.creativeId,
          creativeRevisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          workflowInstanceId: task.instanceId,
          workflowTaskId: task.id,
          reviewerId: user.id,
          decision: input.decision,
          reason: input.reason?.trim() || null,
        },
      });
      const completed = await tx.workflowTask.updateMany({
        where: {
          id: task.id,
          instanceId: task.instanceId,
          status: 'OPEN',
          stageId: task.stageId,
        },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedById: user.id,
        },
      });
      if (completed.count !== 1)
        throw new ConflictException('Review task was already completed');
      if (input.decision === ReviewDecisionType.CHANGES_REQUESTED) {
        const changeRequest = await tx.changeRequest.create({
          data: {
            organizationId: user.organizationId,
            branchId: task.instance.branchId,
            creativeId: task.instance.creativeId,
            creativeRevisionId: revision.id,
            revisionNumber: revision.revisionNumber,
            workflowInstanceId: task.instanceId,
            workflowTaskId: task.id,
            originatingDecisionId: decision.id,
            requestedChanges: input.reason!.trim(),
            explanation: input.explanation?.trim() || null,
            createdById: user.id,
          },
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'change_request.created',
          entityType: 'change_request',
          entityId: changeRequest.id,
          branchId: task.instance.branchId,
          creativeId: task.instance.creativeId,
          creativeRevisionId: revision.id,
          workflowInstanceId: task.instanceId,
          changeRequestId: changeRequest.id,
          metadata: { revisionNumber: revision.revisionNumber },
        });
        const requesterId = task.instance.startedById;
        if (requesterId !== user.id)
          await this.notifications.create(tx, {
            recipientUserId: requesterId,
            organizationId: user.organizationId,
            eventKey: `change-request-created:${changeRequest.id}`,
            type: 'CHANGE_REQUEST_CREATED',
            title: 'Changes requested',
            message: `Changes were requested for ${task.instance.creative.name}.`,
            entityType: 'change_request',
            entityId: changeRequest.id,
            branchId: task.instance.branchId,
            creativeId: task.instance.creativeId,
            creativeRevisionId: revision.id,
            workflowInstanceId: task.instanceId,
            changeRequestId: changeRequest.id,
          });
      }
      await this.workflows.transitionInTransaction(
        tx,
        user,
        task.instanceId,
        transition.key,
        input.reason?.trim(),
        PERMISSIONS.APPROVAL_DECIDE,
      );
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action:
          input.decision === ReviewDecisionType.APPROVED
            ? 'approval.approved'
            : 'approval.changes_requested',
        entityType: 'approval_decision',
        entityId: decision.id,
        branchId: task.instance.branchId,
        creativeId: task.instance.creativeId,
        creativeRevisionId: revision.id,
        workflowInstanceId: task.instanceId,
        metadata: {
          decision: input.decision,
          revisionNumber: revision.revisionNumber,
        },
      });
      if (
        input.decision === ReviewDecisionType.APPROVED &&
        task.instance.startedById !== user.id
      )
        await this.notifications.create(tx, {
          recipientUserId: task.instance.startedById,
          organizationId: user.organizationId,
          eventKey: `approval-decision:${decision.id}`,
          type:
            input.decision === ReviewDecisionType.APPROVED
              ? 'CREATIVE_APPROVED'
              : 'CREATIVE_CHANGES_REQUESTED',
          title:
            input.decision === ReviewDecisionType.APPROVED
              ? 'Creative approved'
              : 'Changes requested',
          message: `A review decision was recorded for ${task.instance.creative.name}.`,
          entityType: 'approval_decision',
          entityId: decision.id,
          branchId: task.instance.branchId,
          creativeId: task.instance.creativeId,
          creativeRevisionId: revision.id,
          workflowInstanceId: task.instanceId,
        });
      return decision;
    });
  }

  async decisions(user: AuthenticatedPrincipal, creativeId: string) {
    this.require(user, PERMISSIONS.APPROVAL_READ);
    await this.assertCreative(user, creativeId);
    return this.prisma.approvalDecision.findMany({
      where: { creativeId, organizationId: user.organizationId },
      include: { reviewer: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async changeRequests(user: AuthenticatedPrincipal, creativeId: string) {
    this.require(user, PERMISSIONS.CHANGE_REQUEST_READ);
    await this.assertCreative(user, creativeId);
    return this.prisma.changeRequest.findMany({
      where: { creativeId, organizationId: user.organizationId },
      include: {
        creator: { select: { id: true, name: true } },
        starter: { select: { id: true, name: true } },
        resolver: { select: { id: true, name: true } },
        canceller: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async changeRequest(user: AuthenticatedPrincipal, id: string) {
    const request = await this.prisma.changeRequest.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, branchId: true, status: true },
    });
    if (!request) throw new NotFoundException('Change request not found');
    const allowed = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? await this.prisma.branch.findFirst({
          where: {
            id: request.branchId,
            organizationId: user.organizationId,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      : await this.prisma.userBranchAccess.findFirst({
          where: {
            userId: user.id,
            branchId: request.branchId,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    if (!allowed) throw new NotFoundException('Change request not found');
    return request;
  }

  async startChangeRequest(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.CHANGE_REQUEST_CREATE);
    await this.changeRequest(user, id);
    return this.updateRequestStatus(
      user,
      id,
      [ChangeRequestStatus.OPEN],
      {
        status: ChangeRequestStatus.IN_PROGRESS,
        startedById: user.id,
        startedAt: new Date(),
      },
      undefined,
      'change_request.started',
    );
  }

  async resolveChangeRequest(
    user: AuthenticatedPrincipal,
    id: string,
    cancel = false,
  ) {
    this.require(user, PERMISSIONS.CHANGE_REQUEST_RESOLVE);
    const request = await this.changeRequest(user, id);
    return this.updateRequestStatus(
      user,
      id,
      [ChangeRequestStatus.OPEN, ChangeRequestStatus.IN_PROGRESS],
      cancel
        ? {
            status: ChangeRequestStatus.CANCELLED,
            cancelledById: user.id,
            cancelledAt: new Date(),
          }
        : {
            status: ChangeRequestStatus.RESOLVED,
            resolvedById: user.id,
            resolvedAt: new Date(),
          },
      request.status,
      cancel ? 'change_request.cancelled' : 'change_request.resolved',
    );
  }

  private async updateRequestStatus(
    user: AuthenticatedPrincipal,
    id: string,
    from: ChangeRequestStatus[],
    data: Prisma.ChangeRequestUncheckedUpdateManyInput,
    current?: ChangeRequestStatus,
    action?: string,
  ) {
    return this.transaction(async (tx) => {
      const result = await tx.changeRequest.updateMany({
        where: {
          id,
          organizationId: user.organizationId,
          status: { in: current ? [current] : from },
        },
        data,
      });
      if (result.count !== 1)
        throw new ConflictException(
          'Change request is no longer in an actionable state',
        );
      const updated = await tx.changeRequest.findUniqueOrThrow({
        where: { id },
      });
      if (action) {
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action,
          entityType: 'change_request',
          entityId: id,
          branchId: updated.branchId,
          creativeId: updated.creativeId,
          creativeRevisionId: updated.creativeRevisionId,
          workflowInstanceId: updated.workflowInstanceId,
          changeRequestId: id,
          metadata: { status: updated.status },
        });
        const recipientId = updated.createdById;
        if (recipientId !== user.id)
          await this.notifications.create(tx, {
            recipientUserId: recipientId,
            organizationId: user.organizationId,
            eventKey: `${action}:${id}`,
            type: action.toUpperCase(),
            title: 'Change request updated',
            message: `A change request is now ${updated.status.toLowerCase().replace('_', ' ')}.`,
            entityType: 'change_request',
            entityId: id,
            branchId: updated.branchId,
            creativeId: updated.creativeId,
            creativeRevisionId: updated.creativeRevisionId,
            workflowInstanceId: updated.workflowInstanceId,
            changeRequestId: id,
          });
      }
      return updated;
    });
  }

  async comments(
    user: AuthenticatedPrincipal,
    creativeId: string,
    revisionNumber: number,
  ) {
    this.require(user, PERMISSIONS.COMMENT_READ);
    await this.assertCreative(user, creativeId);
    const revision = await this.prisma.creativeRevision.findUnique({
      where: { creativeId_revisionNumber: { creativeId, revisionNumber } },
      select: { id: true },
    });
    if (!revision) throw new NotFoundException('Creative revision not found');
    return this.prisma.creativeComment.findMany({
      where: {
        creativeId,
        creativeRevisionId: revision.id,
        organizationId: user.organizationId,
      },
      include: { author: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addComment(
    user: AuthenticatedPrincipal,
    creativeId: string,
    revisionNumber: number,
    text: string,
    parentId?: string,
  ) {
    this.require(user, PERMISSIONS.COMMENT_CREATE);
    const creative = await this.assertCreative(user, creativeId);
    const revision = await this.prisma.creativeRevision.findUnique({
      where: { creativeId_revisionNumber: { creativeId, revisionNumber } },
      select: { id: true },
    });
    if (!revision) throw new NotFoundException('Creative revision not found');
    if (parentId) {
      const parent = await this.prisma.creativeComment.findFirst({
        where: {
          id: parentId,
          creativeId,
          creativeRevisionId: revision.id,
          organizationId: user.organizationId,
        },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('Comment thread not found');
    }
    return this.prisma.$transaction(async (tx) => {
      const comment = await tx.creativeComment.create({
        data: {
          organizationId: user.organizationId,
          branchId: creative.branchId,
          creativeId,
          creativeRevisionId: revision.id,
          parentId: parentId ?? null,
          authorId: user.id,
          text: text.trim(),
        },
        include: { author: { select: { id: true, name: true } } },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'comment.created',
        entityType: 'creative_comment',
        entityId: comment.id,
        branchId: creative.branchId,
        creativeId,
        creativeRevisionId: revision.id,
        metadata: { revisionNumber, parentId: parentId ?? null },
      });
      const activeTask = await tx.workflowTask.findFirst({
        where: {
          status: 'OPEN',
          instance: {
            organizationId: user.organizationId,
            branchId: creative.branchId,
            creativeId,
            creativeRevisionId: revision.id,
            status: 'RUNNING',
          },
          stage: { requiresReview: true },
        },
        select: { id: true, assignedUserId: true, instanceId: true },
      });
      const workflow = activeTask
        ? await tx.workflowInstance.findFirst({
            where: { id: activeTask.instanceId },
            select: { startedById: true },
          })
        : null;
      const activeRequests = await tx.changeRequest.findMany({
        where: {
          organizationId: user.organizationId,
          creativeId,
          creativeRevisionId: revision.id,
          status: {
            in: [ChangeRequestStatus.OPEN, ChangeRequestStatus.IN_PROGRESS],
          },
        },
        select: { id: true, createdById: true, workflowInstanceId: true },
      });
      const recipients = new Set(
        [activeTask?.assignedUserId, workflow?.startedById].filter(
          (id): id is string => Boolean(id) && id !== user.id,
        ),
      );
      for (const request of activeRequests) {
        if (request.createdById !== user.id)
          recipients.add(request.createdById);
      }
      for (const recipientUserId of recipients)
        await this.notifications.create(tx, {
          recipientUserId,
          organizationId: user.organizationId,
          eventKey: `comment:${comment.id}:${recipientUserId}`,
          type: 'REVIEW_COMMENT_ADDED',
          title: 'New review comment',
          message: 'A comment was added to a revision you are reviewing.',
          entityType: 'creative_comment',
          entityId: comment.id,
          branchId: creative.branchId,
          creativeId,
          creativeRevisionId: revision.id,
          workflowInstanceId:
            activeTask?.instanceId ??
            activeRequests[0]?.workflowInstanceId ??
            null,
        });
      return comment;
    });
  }
}

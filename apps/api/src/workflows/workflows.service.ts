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
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  validateWorkflowDefinition,
  type StageDefinition,
  type WorkflowDefinitionInput,
} from './workflow-definition';
import { UNREVIEWED_REVISION_STATUS } from '../creatives/creative-review-state';
import { isRolledBackTransaction } from '../prisma/transaction-errors';

export const CANCEL_REASON_MAX_LENGTH = 1000;
// Run status after cancellation. It frees the creative for a new run (only
// RUNNING runs are unique per creative) and never counts as an approval.
export const CANCELLED_RUN_STATUS = 'CANCELLED';
// History action key of a cancellation; the reason is stored with it.
export const CANCEL_ACTION_KEY = 'CANCEL';
// Why a run cannot start, or enter review, for a revision whose change
// requests are still OPEN or IN_PROGRESS.
export const UNRESOLVED_CHANGE_REQUEST_MESSAGE =
  'Save a new revision with the requested changes before resubmitting.';

const definitionInclude = {
  versions: {
    orderBy: { versionNumber: 'desc' as const },
    include: {
      stages: { orderBy: { displayOrder: 'asc' as const } },
      transitions: { include: { sourceStage: true, destination: true } },
    },
  },
};

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      // A unique-key race, or PostgreSQL rolling the transaction back
      // (deadlock or serialization failure, however Prisma reports it):
      // nothing was applied.
      if (
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002') ||
        isRolledBackTransaction(error)
      )
        throw new ConflictException(
          'Workflow changed concurrently; reload and retry',
        );
      throw error;
    }
  }

  private require(user: AuthenticatedPrincipal, permission: string): void {
    if (!user.permissions.includes(permission))
      throw new ForbiddenException('Permission denied');
  }

  private async assertBranch(
    user: AuthenticatedPrincipal,
    branchId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    const branch = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? await tx.branch.findFirst({
          where: {
            id: branchId,
            organizationId: user.organizationId,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      : await tx.userBranchAccess.findFirst({
          where: {
            userId: user.id,
            branchId,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private async assertAssignees(
    user: AuthenticatedPrincipal,
    definition: WorkflowDefinitionInput,
  ): Promise<void> {
    const permissionCodes = [
      ...new Set(
        definition.stages
          .flatMap((stage) => [
            stage.requiredPermission,
            stage.assignedPermission,
          ])
          .concat(
            definition.transitions.map(
              (transition) => transition.requiredPermission,
            ),
          )
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    if (permissionCodes.length) {
      const permissions = await this.prisma.permission.findMany({
        where: { code: { in: permissionCodes } },
        select: { code: true },
      });
      if (permissions.length !== permissionCodes.length)
        throw new BadRequestException(
          'Workflow references an unknown permission',
        );
    }
    const ids = [
      ...new Set(
        definition.stages.flatMap((stage) =>
          stage.assignedUserId ? [stage.assignedUserId] : [],
        ),
      ),
    ];
    if (!ids.length) return;
    const count = await this.prisma.user.count({
      where: {
        id: { in: ids },
        organizationId: user.organizationId,
        status: 'ACTIVE',
      },
    });
    if (count !== ids.length)
      throw new BadRequestException(
        'Stage assignee must be an active organization user',
      );
  }

  private async writeVersion(
    tx: Prisma.TransactionClient,
    workflowId: string,
    versionNumber: number,
    createdById: string,
    definition: WorkflowDefinitionInput,
  ) {
    const version = await tx.workflowVersion.create({
      data: { workflowId, versionNumber, createdById },
    });
    const stages = await Promise.all(
      definition.stages.map((stage) =>
        tx.workflowStage.create({
          data: {
            versionId: version.id,
            key: stage.key,
            name: stage.name,
            displayOrder: stage.displayOrder,
            isEntry: stage.isEntry ?? false,
            isTerminal: stage.isTerminal ?? false,
            requiredPermission: stage.requiredPermission ?? null,
            assignedUserId: stage.assignedUserId ?? null,
            assignedPermission: stage.assignedPermission ?? null,
            requiresReview: stage.requiresReview ?? false,
          },
        }),
      ),
    );
    const byKey = new Map(stages.map((stage) => [stage.key, stage]));
    for (const transition of definition.transitions) {
      const sourceStage = byKey.get(transition.from);
      const destination = byKey.get(transition.to);
      if (!sourceStage || !destination)
        throw new BadRequestException('Transition references an unknown stage');
      await tx.workflowTransition.create({
        data: {
          versionId: version.id,
          key: transition.key,
          label: transition.label,
          sourceStageId: sourceStage.id,
          destinationStageId: destination.id,
          requiredPermission: transition.requiredPermission ?? null,
          reviewDecision: transition.reviewDecision ?? null,
        },
      });
    }
    return version;
  }

  async list(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.WORKFLOW_READ);
    return this.prisma.workflow.findMany({
      where: { organizationId: user.organizationId },
      include: definitionInclude,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async get(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_READ);
    const workflow = await this.prisma.workflow.findFirst({
      where: { id, organizationId: user.organizationId },
      include: definitionInclude,
    });
    if (!workflow) throw new NotFoundException('Workflow not found');
    return workflow;
  }

  async create(
    user: AuthenticatedPrincipal,
    definition: WorkflowDefinitionInput,
  ) {
    this.require(user, PERMISSIONS.WORKFLOW_MANAGE);
    const errors = validateWorkflowDefinition(definition);
    if (errors.length) throw new BadRequestException(errors);
    await this.assertAssignees(user, definition);
    return this.transaction(async (tx) => {
      const workflow = await tx.workflow.create({
        data: {
          organizationId: user.organizationId,
          name: definition.name,
          description: definition.description ?? null,
          createdById: user.id,
        },
      });
      await this.writeVersion(tx, workflow.id, 1, user.id, definition);
      return tx.workflow.findUniqueOrThrow({
        where: { id: workflow.id },
        include: definitionInclude,
      });
    });
  }

  async update(
    user: AuthenticatedPrincipal,
    id: string,
    definition: WorkflowDefinitionInput,
  ) {
    this.require(user, PERMISSIONS.WORKFLOW_MANAGE);
    const errors = validateWorkflowDefinition(definition);
    if (errors.length) throw new BadRequestException(errors);
    await this.assertAssignees(user, definition);
    return this.transaction(async (tx) => {
      const workflow = await tx.workflow.findFirst({
        where: { id, organizationId: user.organizationId },
      });
      if (!workflow) throw new NotFoundException('Workflow not found');
      const nextVersion = workflow.currentVersionNumber + 1;
      await tx.workflow.update({
        where: { id },
        data: {
          name: definition.name,
          description: definition.description ?? null,
          currentVersionNumber: nextVersion,
          enabledVersionNumber: null,
          status: 'DRAFT',
        },
      });
      await this.writeVersion(tx, id, nextVersion, user.id, definition);
      return tx.workflow.findUniqueOrThrow({
        where: { id },
        include: definitionInclude,
      });
    });
  }

  async validate(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_MANAGE);
    const workflow = await this.get(user, id);
    const version = workflow.versions.find(
      (item) => item.versionNumber === workflow.currentVersionNumber,
    );
    if (!version) throw new NotFoundException('Workflow version not found');
    const errors = this.storedVersionErrors(workflow, version);
    return { valid: errors.length === 0, errors };
  }

  // Validates a stored version with the current definition rules. Versions
  // are immutable once enabled, so a version enabled before a rule existed
  // is only caught here.
  private storedVersionErrors(
    workflow: { name: string; description: string | null },
    version: {
      stages: Array<StageDefinition & { id: string }>;
      transitions: Array<{
        key: string;
        label: string;
        sourceStageId: string;
        destinationStageId: string;
        requiredPermission: string | null;
        reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | null;
      }>;
    },
  ): string[] {
    const stageKeyById = new Map(
      version.stages.map((stage) => [stage.id, stage.key]),
    );
    return validateWorkflowDefinition({
      name: workflow.name,
      description: workflow.description,
      stages: version.stages,
      transitions: version.transitions.map((transition) => ({
        key: transition.key,
        label: transition.label,
        from: stageKeyById.get(transition.sourceStageId) ?? '',
        to: stageKeyById.get(transition.destinationStageId) ?? '',
        requiredPermission: transition.requiredPermission,
        reviewDecision: transition.reviewDecision,
      })),
    });
  }

  async enable(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_MANAGE);
    const result = (await this.validate(user, id)) as {
      valid: boolean;
      errors: string[];
    };
    if (!result.valid) throw new BadRequestException(result.errors);
    return this.transaction(async (tx) => {
      const workflow = await tx.workflow.findFirst({
        where: { id, organizationId: user.organizationId },
      });
      if (!workflow) throw new NotFoundException('Workflow not found');
      const version = await tx.workflowVersion.findUnique({
        where: {
          workflowId_versionNumber: {
            workflowId: id,
            versionNumber: workflow.currentVersionNumber,
          },
        },
      });
      if (!version) throw new NotFoundException('Workflow version not found');
      await tx.workflowVersion.update({
        where: { id: version.id },
        data: { immutableAt: new Date() },
      });
      return tx.workflow.update({
        where: { id },
        data: {
          status: 'ENABLED',
          enabledVersionNumber: workflow.currentVersionNumber,
        },
      });
    });
  }

  async disable(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_MANAGE);
    const existing = await this.prisma.workflow.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!existing) throw new NotFoundException('Workflow not found');
    return this.prisma.workflow.update({
      where: { id },
      data: { status: 'DISABLED' },
    });
  }

  async start(
    user: AuthenticatedPrincipal,
    creativeId: string,
    workflowId: string,
    revisionId?: string,
  ) {
    this.require(user, PERMISSIONS.WORKFLOW_START);
    return this.transaction(async (tx) => {
      const creative = await tx.creative.findFirst({
        where: { id: creativeId, organizationId: user.organizationId },
      });
      if (!creative) throw new NotFoundException('Creative not found');
      await this.assertBranch(user, creative.branchId, tx);
      const active = await tx.workflowInstance.findFirst({
        where: { creativeId, status: 'RUNNING' },
      });
      if (active)
        throw new ConflictException('Creative already has an active workflow');
      const workflow = await tx.workflow.findFirst({
        where: {
          organizationId: user.organizationId,
          status: 'ENABLED',
          id: workflowId,
        },
      });
      if (!workflow || workflow.enabledVersionNumber === null)
        throw new NotFoundException('Enabled workflow not found');
      const version = await tx.workflowVersion.findUnique({
        where: {
          workflowId_versionNumber: {
            workflowId: workflow.id,
            versionNumber: workflow.enabledVersionNumber,
          },
        },
        include: { stages: true, transitions: true },
      });
      if (!version || !version.immutableAt)
        throw new ConflictException('Enabled workflow version is invalid');
      // An enabled version that fails today's rules (for example one enabled
      // before changes-requested routes had to finish without another
      // review) could leave the creative locked, so it starts no runs.
      const definitionErrors = this.storedVersionErrors(workflow, version);
      if (definitionErrors.length)
        throw new ConflictException(
          `Workflow ${workflow.name} cannot start new runs until it is updated and enabled again: ${definitionErrors.join(' ')}`,
        );
      // Only the current revision can be reviewed: decide() refuses any
      // other, so a run for an older revision could never be decided and
      // would leave the creative locked.
      if (!creative.currentRevisionId)
        throw new ConflictException(
          'Creative has no current revision to submit; save a revision first',
        );
      const revision = await tx.creativeRevision.findFirst({
        where: { id: revisionId ?? creative.currentRevisionId, creativeId },
      });
      if (!revision)
        throw new BadRequestException(
          'Creative revision does not belong to this creative',
        );
      if (revision.id !== creative.currentRevisionId) {
        const current = await tx.creativeRevision.findFirst({
          where: { id: creative.currentRevisionId, creativeId },
          select: { revisionNumber: true },
        });
        throw new ConflictException(
          `Only the current revision${current ? ` (${current.revisionNumber})` : ''} can be submitted for review; revision ${revision.revisionNumber} is an older revision`,
        );
      }
      // Changes requested on this exact revision are still unanswered: a new
      // run would only show the reviewer the same revision again. Requests
      // on older revisions do not block; this run resolves them below.
      if (await this.hasUnresolvedChangeRequest(tx, user, revision.id))
        throw new ConflictException(UNRESOLVED_CHANGE_REQUEST_MESSAGE);
      const entry = version.stages.find((stage) => stage.isEntry);
      if (!entry) throw new ConflictException('Workflow has no entry stage');
      if (
        entry.requiredPermission &&
        !user.permissions.includes(entry.requiredPermission)
      )
        throw new ForbiddenException('Permission denied');
      await this.assertStageAssignee(
        user,
        creative.branchId,
        entry.assignedUserId,
        tx,
      );
      const instance = await tx.workflowInstance.create({
        data: {
          organizationId: user.organizationId,
          branchId: creative.branchId,
          creativeId,
          creativeRevisionId: revision.id,
          workflowId: workflow.id,
          workflowVersionId: version.id,
          currentStageId: entry.id,
          startedById: user.id,
        },
      });
      await tx.creative.update({
        where: { id: creative.id },
        data: { status: entry.key },
      });
      await tx.workflowTransitionHistory.create({
        data: {
          instanceId: instance.id,
          versionId: version.id,
          toStageId: entry.id,
          actorId: user.id,
          actionKey: 'START',
        },
      });
      const initialTask = await tx.workflowTask.create({
        data: {
          instanceId: instance.id,
          stageId: entry.id,
          assignedUserId: entry.assignedUserId,
          requiredPermission: entry.assignedPermission,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'workflow.started',
        entityType: 'workflow_instance',
        entityId: instance.id,
        branchId: creative.branchId,
        creativeId: creative.id,
        creativeRevisionId: revision.id,
        workflowInstanceId: instance.id,
        metadata: { workflowId: workflow.id, stage: entry.key },
      });
      await this.resolveAnsweredChangeRequests(tx, user, {
        creative,
        revision,
        instanceId: instance.id,
      });
      if (initialTask.assignedUserId && initialTask.assignedUserId !== user.id)
        await this.notifications.create(tx, {
          recipientUserId: initialTask.assignedUserId,
          organizationId: user.organizationId,
          eventKey: `workflow-task:${initialTask.id}`,
          type: 'REVIEW_TASK_ASSIGNED',
          title: 'Review task assigned',
          message: `A workflow task for ${creative.name} is ready.`,
          entityType: 'workflow_instance',
          entityId: instance.id,
          branchId: creative.branchId,
          creativeId: creative.id,
          creativeRevisionId: revision.id,
          workflowInstanceId: instance.id,
        });
      return tx.workflowInstance.findUniqueOrThrow({
        where: { id: instance.id },
        include: this.instanceInclude(),
      });
    });
  }

  // A run for a newer revision answers the changes requested on earlier
  // revisions, so their open requests are resolved. This runs inside the
  // transaction that creates the run: if the run is not created, every
  // request stays open. Requests keep their rows and audit history; a run for
  // the same revision resolves nothing.
  private async resolveAnsweredChangeRequests(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    run: {
      creative: { id: string; branchId: string; name: string };
      revision: { id: string; revisionNumber: number };
      instanceId: string;
    },
  ): Promise<void> {
    const actionable = [
      ChangeRequestStatus.OPEN,
      ChangeRequestStatus.IN_PROGRESS,
    ];
    const answered = await tx.changeRequest.findMany({
      where: {
        organizationId: user.organizationId,
        creativeId: run.creative.id,
        status: { in: actionable },
        revisionNumber: { lt: run.revision.revisionNumber },
      },
      select: {
        id: true,
        status: true,
        createdById: true,
        revisionNumber: true,
        creativeRevisionId: true,
        workflowInstanceId: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const request of answered) {
      const resolved = await tx.changeRequest.updateMany({
        where: { id: request.id, status: { in: actionable } },
        data: {
          status: ChangeRequestStatus.RESOLVED,
          resolvedById: user.id,
          resolvedAt: new Date(),
        },
      });
      if (resolved.count !== 1)
        throw new ConflictException(
          'Workflow changed concurrently; reload and retry',
        );
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'change_request.resolved',
        entityType: 'change_request',
        entityId: request.id,
        branchId: run.creative.branchId,
        creativeId: run.creative.id,
        creativeRevisionId: request.creativeRevisionId,
        workflowInstanceId: request.workflowInstanceId,
        changeRequestId: request.id,
        metadata: {
          status: ChangeRequestStatus.RESOLVED,
          previousStatus: request.status,
          resolution: 'RESUBMITTED',
          revisionNumber: request.revisionNumber,
          resubmittedRevisionNumber: run.revision.revisionNumber,
          resubmittedWorkflowInstanceId: run.instanceId,
        },
      });
      if (request.createdById !== user.id)
        await this.notifications.create(tx, {
          recipientUserId: request.createdById,
          organizationId: user.organizationId,
          eventKey: `change_request.resolved:${request.id}`,
          type: 'CHANGE_REQUEST.RESOLVED',
          title: 'Creative resubmitted',
          message: `${run.creative.name} was resubmitted as revision ${run.revision.revisionNumber}, resolving your change request on revision ${request.revisionNumber}.`,
          entityType: 'change_request',
          entityId: request.id,
          branchId: run.creative.branchId,
          creativeId: run.creative.id,
          creativeRevisionId: request.creativeRevisionId,
          workflowInstanceId: run.instanceId,
          changeRequestId: request.id,
        });
    }
  }

  private instanceInclude() {
    return {
      currentStage: true,
      workflow: true,
      version: { include: { stages: true, transitions: true } },
      tasks: { where: { status: 'OPEN' }, include: { stage: true } },
      history: {
        orderBy: { createdAt: 'asc' as const },
        include: { fromStage: true, toStage: true },
      },
      // Lets the client show cancellation to the run's starter only while
      // no decision exists; cancel() enforces the same rule.
      _count: { select: { approvalDecisions: true } },
    };
  }

  private async assertStageAssignee(
    user: AuthenticatedPrincipal,
    branchId: string,
    assignedUserId: string | null,
    tx: Prisma.TransactionClient,
  ) {
    if (!assignedUserId) return;
    const valid = await tx.userBranchAccess.findFirst({
      where: {
        userId: assignedUserId,
        branchId,
        user: { organizationId: user.organizationId, status: 'ACTIVE' },
      },
      select: { userId: true },
    });
    if (!valid)
      throw new BadRequestException(
        'Stage assignee is not authorized for this branch',
      );
  }

  async instance(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_READ);
    const instance = await this.prisma.workflowInstance.findFirst({
      where: { id, organizationId: user.organizationId },
      include: this.instanceInclude(),
    });
    if (!instance) throw new NotFoundException('Workflow instance not found');
    await this.assertBranch(user, instance.branchId);
    return instance;
  }

  async creativeState(user: AuthenticatedPrincipal, creativeId: string) {
    this.require(user, PERMISSIONS.WORKFLOW_READ);
    const creative = await this.prisma.creative.findFirst({
      where: { id: creativeId, organizationId: user.organizationId },
    });
    if (!creative) throw new NotFoundException('Creative not found');
    await this.assertBranch(user, creative.branchId);
    const instance = await this.prisma.workflowInstance.findFirst({
      where: { creativeId, organizationId: user.organizationId },
      orderBy: { startedAt: 'desc' },
      include: this.instanceInclude(),
    });
    return instance;
  }

  async transition(
    user: AuthenticatedPrincipal,
    id: string,
    transitionKey: string,
    reason?: string,
  ) {
    return this.transaction((tx) =>
      this.transitionInTransaction(
        tx,
        user,
        id,
        transitionKey,
        reason,
        PERMISSIONS.WORKFLOW_TRANSITION,
      ),
    );
  }

  async transitionInTransaction(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    id: string,
    transitionKey: string,
    reason?: string,
    authorizationPermission: string = PERMISSIONS.WORKFLOW_TRANSITION,
  ) {
    this.require(user, authorizationPermission);
    const instance = await tx.workflowInstance.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { currentStage: true },
    });
    if (!instance) throw new NotFoundException('Workflow instance not found');
    await this.assertBranch(user, instance.branchId, tx);
    if (instance.status !== 'RUNNING')
      throw new ConflictException('Workflow is not running');
    if (
      instance.currentStage.requiresReview &&
      authorizationPermission !== PERMISSIONS.APPROVAL_DECIDE
    )
      throw new ForbiddenException(
        'Review stages require an approval decision',
      );
    const transition = await tx.workflowTransition.findFirst({
      where: {
        versionId: instance.workflowVersionId,
        key: transitionKey,
        sourceStageId: instance.currentStageId,
      },
      include: { destination: true },
    });
    if (!transition)
      throw new BadRequestException(
        'Transition is not allowed from the current stage',
      );
    const required = [
      instance.currentStage.requiredPermission,
      transition.requiredPermission,
      transition.destination.requiredPermission,
    ].filter((item): item is string => Boolean(item));
    if (required.some((permission) => !user.permissions.includes(permission)))
      throw new ForbiddenException('Permission denied');
    const assignedToActor = instance.currentStage.assignedUserId === user.id;
    const hasStageAssignmentPermission = Boolean(
      instance.currentStage.assignedPermission &&
      user.permissions.includes(instance.currentStage.assignedPermission),
    );
    if (
      (instance.currentStage.assignedUserId ||
        instance.currentStage.assignedPermission) &&
      !assignedToActor &&
      !hasStageAssignmentPermission
    )
      throw new ForbiddenException('Permission denied');
    await this.assertStageAssignee(
      user,
      instance.branchId,
      transition.destination.assignedUserId,
      tx,
    );
    // Entering a review with unanswered change requests on the run's own
    // revision would ask for a decision on a revision already known to need
    // changes. This also covers an approval that leads into a further review.
    if (
      transition.destination.requiresReview &&
      (await this.hasUnresolvedChangeRequest(
        tx,
        user,
        instance.creativeRevisionId,
      ))
    )
      throw new ConflictException(
        `Revision cannot enter review stage ${transition.destination.name} while it has unresolved change requests. ${UNRESOLVED_CHANGE_REQUEST_MESSAGE}`,
      );
    const updated = await tx.workflowInstance.updateMany({
      where: {
        id,
        status: 'RUNNING',
        currentStageId: instance.currentStageId,
      },
      data: {
        currentStageId: transition.destinationStageId,
        ...(transition.destination.isTerminal
          ? { status: 'COMPLETED', completedAt: new Date() }
          : {}),
      },
    });
    if (updated.count !== 1)
      throw new ConflictException(
        'Workflow changed concurrently; reload and retry',
      );
    await tx.workflowTask.updateMany({
      where: { instanceId: id, status: 'OPEN' },
      data: { status: 'STALE' },
    });
    const nextTask = !transition.destination.isTerminal
      ? await tx.workflowTask.create({
          data: {
            instanceId: id,
            stageId: transition.destination.id,
            assignedUserId: transition.destination.assignedUserId,
            requiredPermission: transition.destination.assignedPermission,
          },
        })
      : null;
    await tx.workflowTransitionHistory.create({
      data: {
        instanceId: id,
        versionId: instance.workflowVersionId,
        fromStageId: instance.currentStageId,
        toStageId: transition.destination.id,
        actorId: user.id,
        actionKey: transition.key,
        reason: reason ?? null,
      },
    });
    await this.audit.write(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'workflow.transitioned',
      entityType: 'workflow_instance',
      entityId: id,
      branchId: instance.branchId,
      creativeId: instance.creativeId,
      creativeRevisionId: instance.creativeRevisionId,
      workflowInstanceId: id,
      metadata: {
        transition: transition.key,
        from: instance.currentStage.key,
        to: transition.destination.key,
      },
    });
    if (nextTask?.assignedUserId && nextTask.assignedUserId !== user.id)
      await this.notifications.create(tx, {
        recipientUserId: nextTask.assignedUserId,
        organizationId: user.organizationId,
        eventKey: `workflow-task:${nextTask.id}`,
        type: transition.destination.requiresReview
          ? 'REVIEW_TASK_ASSIGNED'
          : 'WORKFLOW_TASK_ASSIGNED',
        title: transition.destination.requiresReview
          ? 'Review task assigned'
          : 'Workflow task assigned',
        message: 'A workflow task is ready for a creative in your branch.',
        entityType: 'workflow_instance',
        entityId: id,
        branchId: instance.branchId,
        creativeId: instance.creativeId,
        creativeRevisionId: instance.creativeRevisionId,
        workflowInstanceId: id,
      });
    await tx.creative.update({
      where: { id: instance.creativeId },
      data: { status: transition.destination.key },
    });
    if (transition.destination.isTerminal)
      await this.notifyRunApproved(tx, user, instance);
    return tx.workflowInstance.findUniqueOrThrow({
      where: { id },
      include: this.instanceInclude(),
    });
  }

  private async hasUnresolvedChangeRequest(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    creativeRevisionId: string,
  ): Promise<boolean> {
    const unresolved = await tx.changeRequest.count({
      where: {
        organizationId: user.organizationId,
        creativeRevisionId,
        status: {
          in: [ChangeRequestStatus.OPEN, ChangeRequestStatus.IN_PROGRESS],
        },
      },
    });
    return unresolved > 0;
  }

  // The "Creative approved" notice is sent when a run completes and, as in
  // the Stage 10.1 approval rule, every decision recorded in it is an
  // approval. An approval at an earlier review stage only moves the run on,
  // so it announces nothing yet. The event key is per run, so the notice is
  // created at most once.
  private async notifyRunApproved(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    run: {
      id: string;
      branchId: string;
      creativeId: string;
      creativeRevisionId: string;
      startedById: string;
    },
  ): Promise<void> {
    if (run.startedById === user.id) return;
    const decisions = await tx.approvalDecision.findMany({
      where: { workflowInstanceId: run.id },
      select: {
        id: true,
        decision: true,
        revisionNumber: true,
        reviewer: { select: { name: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (
      !decisions.length ||
      decisions.some((item) => item.decision !== ReviewDecisionType.APPROVED)
    )
      return;
    const final = decisions[0]!;
    const creative = await tx.creative.findUnique({
      where: { id: run.creativeId },
      select: { name: true },
    });
    await this.notifications.create(tx, {
      recipientUserId: run.startedById,
      organizationId: user.organizationId,
      eventKey: `creative-approved:${run.id}`,
      type: 'CREATIVE_APPROVED',
      title: 'Creative approved',
      message: `${final.reviewer.name} approved revision ${final.revisionNumber} of ${creative?.name ?? 'the creative'}.`,
      entityType: 'approval_decision',
      entityId: final.id,
      branchId: run.branchId,
      creativeId: run.creativeId,
      creativeRevisionId: run.creativeRevisionId,
      workflowInstanceId: run.id,
    });
  }

  // Ends a RUNNING run without completing it, so a creative held by a run
  // that cannot move on can be revised and resubmitted. A workflow manager
  // may cancel any run in a branch they can access; whoever started the run
  // may cancel it only while no review decision has been recorded in it.
  // Decisions, change requests and history are kept; open tasks go stale.
  async cancel(user: AuthenticatedPrincipal, id: string, reason: string) {
    const manager = user.permissions.includes(PERMISSIONS.WORKFLOW_MANAGE);
    if (!manager && !user.permissions.includes(PERMISSIONS.WORKFLOW_START))
      throw new ForbiddenException('Permission denied');
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > CANCEL_REASON_MAX_LENGTH)
      throw new BadRequestException(
        `A cancellation reason of 1 to ${CANCEL_REASON_MAX_LENGTH} characters is required`,
      );
    return this.transaction(async (tx) => {
      const instance = await tx.workflowInstance.findFirst({
        where: { id, organizationId: user.organizationId },
        include: {
          currentStage: true,
          workflow: { select: { id: true, name: true } },
          creative: { select: { id: true, name: true } },
        },
      });
      if (!instance) throw new NotFoundException('Workflow instance not found');
      // Out-of-scope runs look the same as missing ones.
      await this.assertBranch(user, instance.branchId, tx);
      if (!manager && instance.startedById !== user.id)
        throw new ForbiddenException(
          'Only a workflow manager or the person who started this run can cancel it',
        );
      if (instance.status !== 'RUNNING')
        throw new ConflictException('Workflow is not running');
      if (!manager) {
        const decisions = await tx.approvalDecision.count({
          where: { workflowInstanceId: id },
        });
        if (decisions)
          throw new ForbiddenException(
            'A review decision has been recorded in this run; only a workflow manager can cancel it now',
          );
      }
      // Guarded like a transition: a concurrent decision or transition
      // (or another cancellation) changes the row first and this fails
      // with 409 before anything else is written.
      const cancelled = await tx.workflowInstance.updateMany({
        where: {
          id,
          status: 'RUNNING',
          currentStageId: instance.currentStageId,
        },
        data: { status: CANCELLED_RUN_STATUS, completedAt: new Date() },
      });
      if (cancelled.count !== 1)
        throw new ConflictException(
          'Workflow changed concurrently; reload and retry',
        );
      const openTasks = await tx.workflowTask.findMany({
        where: { instanceId: id, status: 'OPEN' },
        select: { assignedUserId: true },
      });
      await tx.workflowTask.updateMany({
        where: { instanceId: id, status: 'OPEN' },
        data: { status: 'STALE' },
      });
      await tx.workflowTransitionHistory.create({
        data: {
          instanceId: id,
          versionId: instance.workflowVersionId,
          fromStageId: instance.currentStageId,
          toStageId: instance.currentStageId,
          actorId: user.id,
          actionKey: CANCEL_ACTION_KEY,
          reason: trimmed,
        },
      });
      // The run is the creative's latest (only one may be RUNNING), and its
      // revision has left review without a result.
      await tx.creative.update({
        where: { id: instance.creativeId },
        data: { status: UNREVIEWED_REVISION_STATUS },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'workflow.cancelled',
        entityType: 'workflow_instance',
        entityId: id,
        branchId: instance.branchId,
        creativeId: instance.creativeId,
        creativeRevisionId: instance.creativeRevisionId,
        workflowInstanceId: id,
        metadata: {
          workflowId: instance.workflow.id,
          previousStage: instance.currentStage.key,
          reason: trimmed,
          cancelledAs: manager ? 'WORKFLOW_MANAGER' : 'STARTER',
          staleTaskCount: openTasks.length,
        },
      });
      const recipients = new Set(
        [
          instance.startedById,
          ...openTasks.map((task) => task.assignedUserId),
        ].filter(
          (recipient): recipient is string =>
            Boolean(recipient) && recipient !== user.id,
        ),
      );
      for (const recipientUserId of recipients)
        await this.notifications.create(tx, {
          recipientUserId,
          organizationId: user.organizationId,
          eventKey: `workflow-cancelled:${id}`,
          type: 'WORKFLOW_CANCELLED',
          title: 'Workflow cancelled',
          message: `${user.name} cancelled the ${instance.workflow.name} run for ${instance.creative.name} at the ${instance.currentStage.name} stage: ${trimmed}`,
          entityType: 'workflow_instance',
          entityId: id,
          branchId: instance.branchId,
          creativeId: instance.creativeId,
          creativeRevisionId: instance.creativeRevisionId,
          workflowInstanceId: id,
        });
      return tx.workflowInstance.findUniqueOrThrow({
        where: { id },
        include: this.instanceInclude(),
      });
    });
  }

  async history(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_READ);
    const instance = await this.prisma.workflowInstance.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, branchId: true },
    });
    if (!instance) throw new NotFoundException('Workflow instance not found');
    await this.assertBranch(user, instance.branchId);
    return this.prisma.workflowTransitionHistory.findMany({
      where: { instanceId: id },
      orderBy: { createdAt: 'asc' },
      include: {
        fromStage: true,
        toStage: true,
        actor: { select: { id: true, name: true } },
      },
    });
  }

  async outgoingTransitions(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.WORKFLOW_TRANSITION);
    const instance = await this.instance(user, id);
    if (instance.status !== 'RUNNING') return [];
    const currentStage = instance.currentStage;
    const assignedToActor = currentStage.assignedUserId === user.id;
    const hasAssignmentPermission = Boolean(
      currentStage.assignedPermission &&
      user.permissions.includes(currentStage.assignedPermission),
    );
    if (
      (currentStage.assignedUserId || currentStage.assignedPermission) &&
      !assignedToActor &&
      !hasAssignmentPermission
    )
      return [];
    return instance.version.transitions
      .filter((transition) => transition.sourceStageId === currentStage.id)
      .filter((transition) => {
        const destination = instance.version.stages.find(
          (stage) => stage.id === transition.destinationStageId,
        );
        return [
          currentStage.requiredPermission,
          transition.requiredPermission,
          destination?.requiredPermission,
        ].every(
          (permission) => !permission || user.permissions.includes(permission),
        );
      })
      .map((transition) => ({
        key: transition.key,
        label: transition.label,
        destination: instance.version.stages.find(
          (stage) => stage.id === transition.destinationStageId,
        ),
      }));
  }
}

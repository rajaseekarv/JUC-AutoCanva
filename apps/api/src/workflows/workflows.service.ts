import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  validateWorkflowDefinition,
  type WorkflowDefinitionInput,
} from './workflow-definition';

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
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || error.code === 'P2002')
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
    const stageKeyById = new Map(
      version.stages.map((stage) => [stage.id, stage.key]),
    );
    const errors = validateWorkflowDefinition({
      name: workflow.name,
      description: workflow.description,
      stages: version.stages.map((stage) => ({
        ...stage,
        assignedUserId: stage.assignedUserId,
      })),
      transitions: version.transitions.map((transition) => ({
        key: transition.key,
        label: transition.label,
        from: stageKeyById.get(transition.sourceStageId) ?? '',
        to: stageKeyById.get(transition.destinationStageId) ?? '',
        requiredPermission: transition.requiredPermission,
        reviewDecision: transition.reviewDecision,
      })),
    });
    return { valid: errors.length === 0, errors };
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
        include: { stages: true },
      });
      if (!version || !version.immutableAt)
        throw new ConflictException('Enabled workflow version is invalid');
      const revision = await tx.creativeRevision.findFirst({
        where: {
          id: revisionId ?? creative.currentRevisionId ?? '',
          creativeId,
        },
      });
      if (!revision)
        throw new BadRequestException(
          'Creative revision does not belong to this creative',
        );
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
    return tx.workflowInstance.findUniqueOrThrow({
      where: { id },
      include: this.instanceInclude(),
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

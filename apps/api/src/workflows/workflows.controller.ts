import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { WorkflowsService } from './workflows.service';

const stage = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    name: z.string().trim().min(1).max(120),
    displayOrder: z.number().int().min(0).max(10000),
    isEntry: z.boolean().optional(),
    isTerminal: z.boolean().optional(),
    requiredPermission: z.string().trim().min(1).max(120).nullable().optional(),
    assignedUserId: z.string().trim().min(1).nullable().optional(),
    assignedPermission: z.string().trim().min(1).max(120).nullable().optional(),
    requiresReview: z.boolean().optional(),
  })
  .strict();
const transition = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(120),
    from: z.string().trim().min(1).max(64),
    to: z.string().trim().min(1).max(64),
    requiredPermission: z.string().trim().min(1).max(120).nullable().optional(),
    reviewDecision: z
      .enum(['APPROVED', 'CHANGES_REQUESTED'])
      .nullable()
      .optional(),
  })
  .strict();
const definition = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    stages: z.array(stage).min(1).max(100),
    transitions: z.array(transition).max(300),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid workflow data');
  return result.data;
}

@Controller()
@UseGuards(JwtAuthGuard, PermissionGuard)
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('workflows')
  @RequirePermissions(PERMISSIONS.WORKFLOW_READ)
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.workflows.list(user);
  }

  @Post('workflows')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: unknown) {
    return this.workflows.create(user, parse(definition, body));
  }

  @Get('workflows/:workflowId')
  @RequirePermissions(PERMISSIONS.WORKFLOW_READ)
  get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('workflowId') id: string,
  ) {
    return this.workflows.get(user, id);
  }

  @Patch('workflows/:workflowId')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('workflowId') id: string,
    @Body() body: unknown,
  ) {
    return this.workflows.update(user, id, parse(definition, body));
  }

  @Post('workflows/:workflowId/validate')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  validate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('workflowId') id: string,
  ) {
    return this.workflows.validate(user, id);
  }

  @Post('workflows/:workflowId/enable')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  enable(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('workflowId') id: string,
  ) {
    return this.workflows.enable(user, id);
  }

  @Post('workflows/:workflowId/disable')
  @RequirePermissions(PERMISSIONS.WORKFLOW_MANAGE)
  disable(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('workflowId') id: string,
  ) {
    return this.workflows.disable(user, id);
  }

  @Post('creatives/:creativeId/workflows')
  @RequirePermissions(PERMISSIONS.WORKFLOW_START)
  start(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') creativeId: string,
    @Body() body: unknown,
  ) {
    const data = parse(
      z
        .object({
          workflowId: z.string().min(1),
          creativeRevisionId: z.string().optional(),
        })
        .strict(),
      body,
    );
    return this.workflows.start(
      user,
      creativeId,
      data.workflowId,
      data.creativeRevisionId,
    );
  }

  @Get('creatives/:creativeId/workflow')
  @RequirePermissions(PERMISSIONS.WORKFLOW_READ)
  creativeState(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') creativeId: string,
  ) {
    return this.workflows.creativeState(user, creativeId);
  }

  @Get('workflow-instances/:instanceId')
  @RequirePermissions(PERMISSIONS.WORKFLOW_READ)
  instance(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('instanceId') id: string,
  ) {
    return this.workflows.instance(user, id);
  }

  @Get('workflow-instances/:instanceId/history')
  @RequirePermissions(PERMISSIONS.WORKFLOW_READ)
  history(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('instanceId') id: string,
  ) {
    return this.workflows.history(user, id);
  }

  @Get('workflow-instances/:instanceId/transitions')
  @RequirePermissions(PERMISSIONS.WORKFLOW_TRANSITION)
  outgoingTransitions(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('instanceId') id: string,
  ) {
    return this.workflows.outgoingTransitions(user, id);
  }

  @Post('workflow-instances/:instanceId/transitions')
  @RequirePermissions(PERMISSIONS.WORKFLOW_TRANSITION)
  transition(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('instanceId') id: string,
    @Body() body: unknown,
  ) {
    const data = parse(
      z
        .object({
          transitionKey: z.string().min(1).max(64),
          reason: z.string().trim().max(1000).nullable().optional(),
        })
        .strict(),
      body,
    );
    return this.workflows.transition(
      user,
      id,
      data.transitionKey,
      data.reason ?? undefined,
    );
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ReviewDecisionType } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { ApprovalsService } from './approvals.service';

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('Invalid review data');
  return result.data;
}

const decisionSchema = z
  .object({
    decision: z.nativeEnum(ReviewDecisionType),
    reason: z.string().trim().max(5000).optional(),
    explanation: z.string().trim().max(5000).optional(),
  })
  .strict();
const commentSchema = z
  .object({
    text: z.string().trim().min(1).max(5000),
    parentId: z.string().min(1).max(128).optional(),
  })
  .strict();

@Controller()
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('approvals/tasks')
  @RequirePermissions(PERMISSIONS.APPROVAL_READ)
  pending(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.approvals.pending(user);
  }

  @Get('approvals/tasks/:taskId')
  @RequirePermissions(PERMISSIONS.APPROVAL_READ)
  context(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('taskId') taskId: string,
  ) {
    return this.approvals.context(user, taskId);
  }

  @Post('approvals/tasks/:taskId/decision')
  @RequirePermissions(PERMISSIONS.APPROVAL_DECIDE)
  decide(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('taskId') taskId: string,
    @Body() body: unknown,
  ) {
    return this.approvals.decide(user, taskId, parse(decisionSchema, body));
  }

  @Get('creatives/:creativeId/decisions')
  @RequirePermissions(PERMISSIONS.APPROVAL_READ)
  decisions(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') id: string,
  ) {
    return this.approvals.decisions(user, id);
  }

  @Get('creatives/:creativeId/change-requests')
  @RequirePermissions(PERMISSIONS.CHANGE_REQUEST_READ)
  changeRequests(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') id: string,
  ) {
    return this.approvals.changeRequests(user, id);
  }

  @Post('change-requests/:id/start')
  @RequirePermissions(PERMISSIONS.CHANGE_REQUEST_CREATE)
  startChangeRequest(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.approvals.startChangeRequest(user, id);
  }

  @Post('change-requests/:id/resolve')
  @RequirePermissions(PERMISSIONS.CHANGE_REQUEST_RESOLVE)
  resolveChangeRequest(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.approvals.resolveChangeRequest(user, id);
  }

  @Post('change-requests/:id/cancel')
  @RequirePermissions(PERMISSIONS.CHANGE_REQUEST_RESOLVE)
  cancelChangeRequest(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.approvals.resolveChangeRequest(user, id, true);
  }

  @Get('creatives/:creativeId/revisions/:revisionNumber/comments')
  @RequirePermissions(PERMISSIONS.COMMENT_READ)
  comments(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') creativeId: string,
    @Param('revisionNumber', ParseIntPipe) revisionNumber: number,
  ) {
    return this.approvals.comments(user, creativeId, revisionNumber);
  }

  @Post('creatives/:creativeId/revisions/:revisionNumber/comments')
  @RequirePermissions(PERMISSIONS.COMMENT_CREATE)
  addComment(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') creativeId: string,
    @Param('revisionNumber', ParseIntPipe) revisionNumber: number,
    @Body() body: unknown,
  ) {
    const data = parse(commentSchema, body);
    return this.approvals.addComment(
      user,
      creativeId,
      revisionNumber,
      data.text,
      data.parentId,
    );
  }
}

import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { AuditService } from './audit.service';

const querySchema = z
  .object({
    action: z.string().max(100).optional(),
    entityType: z.string().max(80).optional(),
    entityId: z.string().max(100).optional(),
    branchId: z.string().max(100).optional(),
    actorUserId: z.string().max(100).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

@Controller('audit-logs')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(PERMISSIONS.AUDIT_READ)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() query: Record<string, unknown>,
  ) {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Invalid audit filters');
    return this.audit.list(user, parsed.data);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedPrincipal, @Param('id') id: string) {
    return this.audit.get(user, id);
  }
}

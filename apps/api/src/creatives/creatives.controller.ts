import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Patch,
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
import { CreativesService } from './creatives.service';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    branchId: z.string().trim().min(1).max(128),
    templateVersionId: z.string().trim().min(1).max(128),
    values: z.record(z.string(), z.unknown()),
    campaignId: z.string().trim().min(1).max(128).nullable().optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    templateVersionId: z.string().trim().min(1).max(128).optional(),
    values: z.record(z.string(), z.unknown()).optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('Invalid creative data');
  return result.data;
}

@Controller('creatives')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class CreativesController {
  constructor(private readonly creatives: CreativesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CREATIVE_READ)
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query('branchId') branchId?: string,
  ) {
    return this.creatives.list(user, branchId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CREATIVE_CREATE)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: unknown) {
    return this.creatives.create(user, parse(createSchema, body));
  }

  @Get(':creativeId/revisions/:revisionNumber')
  @RequirePermissions(PERMISSIONS.CREATIVE_READ)
  revision(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') id: string,
    @Param('revisionNumber', ParseIntPipe) revisionNumber: number,
  ) {
    return this.creatives.revision(user, id, revisionNumber);
  }

  @Get(':creativeId/revisions')
  @RequirePermissions(PERMISSIONS.CREATIVE_READ)
  revisions(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') id: string,
  ) {
    return this.creatives.revisions(user, id);
  }

  @Get(':creativeId')
  @RequirePermissions(PERMISSIONS.CREATIVE_READ)
  get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') id: string,
  ) {
    return this.creatives.get(user, id);
  }

  @Patch(':creativeId')
  @RequirePermissions(PERMISSIONS.CREATIVE_UPDATE)
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('creativeId') id: string,
    @Body() body: unknown,
  ) {
    return this.creatives.update(user, id, parse(updateSchema, body));
  }
}

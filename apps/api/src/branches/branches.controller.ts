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
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { BranchAccessGuard } from './branch-access.guard';
import { BranchesService } from './branches.service';

const nullableText = (maximum: number) =>
  z.string().trim().max(maximum).nullable().optional();
const branchFields = {
  name: z.string().trim().min(1).max(120).optional(),
  code: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  address: nullableText(250),
  city: nullableText(100),
  state: nullableText(100),
  pincode: nullableText(20),
  phone: nullableText(40),
  whatsapp: nullableText(40),
  email: z.string().trim().email().max(254).nullable().optional(),
  googleMapsUrl: z.string().trim().url().max(2048).nullable().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
} as const;
const createBranchSchema = z
  .object(branchFields)
  .strict()
  .required({ name: true, code: true });
const updateBranchSchema = z
  .object(branchFields)
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one branch field is required',
  );

function parseBranchInput(
  schema: typeof createBranchSchema | typeof updateBranchSchema,
  body: unknown,
) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException('Invalid branch profile');
  return parsed.data;
}

@Controller('branches')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.BRANCH_READ)
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.branchesService.listAccessible(user);
  }

  @Get(':branchId')
  @UseGuards(BranchAccessGuard)
  @RequirePermissions(PERMISSIONS.BRANCH_READ)
  getBranch(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
  ) {
    return this.branchesService.getAccessible(user, branchId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: unknown) {
    const parsed = createBranchSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid branch profile');
    return this.branchesService.create(user, parsed.data);
  }

  @Patch(':branchId')
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    return this.branchesService.update(
      user,
      branchId,
      parseBranchInput(updateBranchSchema, body),
    );
  }

  @Post(':branchId/activate')
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  activate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
  ) {
    return this.branchesService.setStatus(user, branchId, 'ACTIVE');
  }

  @Post(':branchId/deactivate')
  @RequirePermissions(PERMISSIONS.BRANCH_MANAGE)
  deactivate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
  ) {
    return this.branchesService.setStatus(user, branchId, 'INACTIVE');
  }
}

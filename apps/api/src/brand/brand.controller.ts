import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { BranchAccessGuard } from '../branches/branch-access.guard';
import { PERMISSIONS } from '../auth/permissions';
import { BrandService, type BrandInput } from './brand.service';

const brandSchema = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    secondaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    fontFamily: z.string().trim().max(120).nullable().optional(),
    websiteUrl: z.string().url().max(2048).nullable().optional(),
    logoAssetId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

@Controller()
@UseGuards(JwtAuthGuard, PermissionGuard)
export class BrandController {
  constructor(private readonly brand: BrandService) {}
  @Get('organization/brand')
  @RequirePermissions(PERMISSIONS.BRAND_READ)
  organization(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.brand.organization(user);
  }
  @Patch('organization/brand')
  @RequirePermissions(PERMISSIONS.BRAND_MANAGE, PERMISSIONS.ORGANIZATION_UPDATE)
  updateOrganization(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: unknown,
  ) {
    return this.update(body, (input) =>
      this.brand.updateOrganization(user, input),
    );
  }
  @Get('branches/:branchId/brand')
  @UseGuards(BranchAccessGuard)
  @RequirePermissions(PERMISSIONS.BRAND_READ)
  branch(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
  ) {
    return this.brand.branchProfile(user, branchId);
  }
  @Patch('branches/:branchId/brand')
  @UseGuards(BranchAccessGuard)
  @RequirePermissions(PERMISSIONS.BRAND_MANAGE)
  updateBranch(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
    @Body() body: unknown,
  ) {
    return this.update(body, (input) =>
      this.brand.updateBranch(user, branchId, input),
    );
  }
  @Get('branches/:branchId/brand/effective')
  @UseGuards(BranchAccessGuard)
  @RequirePermissions(PERMISSIONS.BRAND_READ)
  effective(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('branchId') branchId: string,
  ) {
    return this.brand.effective(user, branchId);
  }
  private update(body: unknown, save: (input: BrandInput) => Promise<unknown>) {
    const parsed = brandSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid brand profile');
    return save(parsed.data);
  }
}

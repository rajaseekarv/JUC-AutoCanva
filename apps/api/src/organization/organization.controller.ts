import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { OrganizationService } from './organization.service';

const organizationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    code: z
      .string()
      .trim()
      .min(2)
      .max(50)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one profile field is required',
  );

@Controller('organization')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get()
  getOwn(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.organizationService.getOwn(user);
  }

  @Patch()
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  updateOwn(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: unknown,
  ) {
    const parsed = organizationUpdateSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid organization profile');
    return this.organizationService.updateOwn(user, parsed.data);
  }
}

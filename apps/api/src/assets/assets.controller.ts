import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  AssetsService,
  type UploadedFile as UploadedFileData,
} from './assets.service';

const updateSchema = z
  .object({
    originalName: z.string().trim().min(1).max(180).optional(),
    branchId: z.string().trim().min(1).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
@Controller('assets')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}
  @Get()
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query('branchId') branchId?: string,
  ) {
    return this.assets.list(user, branchId);
  }
  @Get(':assetId/content')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  async content(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
    @Res() response: Response,
  ) {
    const result = await this.assets.content(user, id);
    response.setHeader('Content-Type', result.asset.mimeType);
    response.setHeader(
      'Content-Disposition',
      'inline; filename="' +
        result.asset.originalName.replace(/["\\r\\n]/g, '') +
        '"',
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    result.stream.pipe(response);
  }
  @Get(':assetId')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
  ) {
    return this.assets.get(user, id);
  }
  @Post()
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    }),
  )
  upload(
    @CurrentUser() user: AuthenticatedPrincipal,
    @UploadedFile() file: UploadedFileData | undefined,
    @Query('branchId') branchId?: string,
  ) {
    return this.assets.upload(user, file, branchId);
  }
  @Patch(':assetId')
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid asset update');
    return this.assets.update(user, id, parsed.data);
  }
  @Delete(':assetId')
  @RequirePermissions(PERMISSIONS.ASSET_MANAGE)
  remove(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
  ) {
    return this.assets.remove(user, id);
  }
}

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
import {
  attachmentContentDisposition,
  inlineContentDisposition,
} from './content-disposition';

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
  content(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
    @Res() response: Response,
  ) {
    return this.send(user, id, response, inlineContentDisposition);
  }
  // The same authorized bytes as /content, marked as a file to save.
  @Get(':assetId/download')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  download(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
    @Res() response: Response,
  ) {
    return this.send(user, id, response, attachmentContentDisposition);
  }
  private async send(
    user: AuthenticatedPrincipal,
    id: string,
    response: Response,
    disposition: (originalName: string) => string,
  ) {
    const result = await this.assets.content(user, id);
    response.setHeader('Content-Type', result.asset.mimeType);
    response.setHeader(
      'Content-Disposition',
      disposition(result.asset.originalName),
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // Access can be revoked or the asset deleted at any time, so no browser
    // or proxy may keep a copy, and the bytes can never run as a document.
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    // A read error must not escape as an unhandled 'error' event, which would
    // stop the process. Before any bytes are sent a generic 500 replaces the
    // image response; afterwards the only safe option is to end the
    // connection. Closing the response early also releases the file.
    result.stream.once('error', () => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.removeHeader('Content-Type');
      response.removeHeader('Content-Disposition');
      response
        .status(500)
        .json({ statusCode: 500, message: 'Internal server error' });
    });
    response.once('close', () => result.stream.destroy());
    result.stream.pipe(response);
  }
  @Get(':assetId/usage')
  @RequirePermissions(PERMISSIONS.ASSET_READ)
  usage(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('assetId') id: string,
  ) {
    return this.assets.usage(user, id);
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

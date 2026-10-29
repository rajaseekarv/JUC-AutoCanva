import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ASSET_STORAGE, type AssetStorage } from './asset-storage';

const maxBytes = 5 * 1024 * 1024;
const imageTypes: Record<
  string,
  { extension: string; matches: (data: Buffer) => boolean }
> = {
  'image/png': {
    extension: '.png',
    matches: (data) =>
      data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  'image/jpeg': {
    extension: '.jpg',
    matches: (data) =>
      data[0] === 255 &&
      data[1] === 216 &&
      data[data.length - 2] === 255 &&
      data[data.length - 1] === 217,
  },
  'image/webp': {
    extension: '.webp',
    matches: (data) =>
      data.toString('ascii', 0, 4) === 'RIFF' &&
      data.toString('ascii', 8, 12) === 'WEBP',
  },
};
const select = {
  id: true,
  organizationId: true,
  branchId: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;
export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

function dimensions(
  type: string,
  data: Buffer,
): { width: number | null; height: number | null } {
  if (type === 'image/png' && data.length >= 24)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (type === 'image/jpeg' && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > data.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      }
      offset += length + 2;
    }
  }
  if (type === 'image/webp' && data.length >= 30) {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X')
      return {
        width: 1 + data.readUIntLE(24, 3),
        height: 1 + data.readUIntLE(27, 3),
      };
    if (chunk === 'VP8L' && data[20] === 0x2f) {
      return {
        width: 1 + (((data[22] & 0x3f) << 8) | data[21]),
        height:
          1 +
          (((data[22] & 0xc0) << 2) |
            (data[23] << 2) |
            ((data[24] & 0x30) >> 4)),
      };
    }
    if (
      chunk === 'VP8 ' &&
      data.length >= 30 &&
      data[23] === 0x9d &&
      data[24] === 0x01 &&
      data[25] === 0x2a
    ) {
      return {
        width: data.readUInt16LE(26) & 0x3fff,
        height: data.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  return { width: null, height: null };
}
function cleanName(name: string): string {
  const basename = name.replaceAll('\\', '/').split('/').at(-1) ?? 'asset';
  return (
    Array.from(basename)
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      })
      .join('')
      .trim()
      .slice(0, 180) || 'asset'
  );
}

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(ASSET_STORAGE) private readonly storage: AssetStorage,
  ) {}

  private has(user: AuthenticatedPrincipal, permission: string): boolean {
    return user.permissions.includes(permission);
  }

  private canManageOrganization(user: AuthenticatedPrincipal): boolean {
    return this.has(user, PERMISSIONS.ORGANIZATION_UPDATE);
  }

  private async assertBranch(
    user: AuthenticatedPrincipal,
    branchId: string,
  ): Promise<void> {
    const branch = this.has(user, PERMISSIONS.BRANCH_MANAGE)
      ? await this.prisma.branch.findFirst({
          where: { id: branchId, organizationId: user.organizationId },
          select: { id: true },
        })
      : await this.prisma.userBranchAccess.findFirst({
          where: {
            userId: user.id,
            branchId,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    if (!branch) throw new ForbiddenException('Branch access denied');
  }

  private async authorizedAsset(user: AuthenticatedPrincipal, assetId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        organizationId: user.organizationId,
        status: 'ACTIVE',
      },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.branchId) await this.assertBranch(user, asset.branchId);
    return asset;
  }

  async assertCreativeAsset(
    user: AuthenticatedPrincipal,
    assetId: string,
    branchId: string,
  ): Promise<void> {
    await this.assertBranch(user, branchId);
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        organizationId: user.organizationId,
        status: 'ACTIVE',
        mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
        OR: [{ branchId: null }, { branchId }],
      },
      select: { id: true },
    });
    if (!asset)
      throw new BadRequestException('Select an in-scope active image asset');
  }

  async list(user: AuthenticatedPrincipal, branchId?: string) {
    if (!this.has(user, PERMISSIONS.ASSET_READ))
      throw new ForbiddenException('Permission denied');
    if (branchId) await this.assertBranch(user, branchId);
    const assets = await this.prisma.asset.findMany({
      where: {
        organizationId: user.organizationId,
        status: 'ACTIVE',
        ...(branchId
          ? { OR: [{ branchId: null }, { branchId }] }
          : this.has(user, PERMISSIONS.ASSET_MANAGE) &&
              this.canManageOrganization(user)
            ? {}
            : { branchId: null }),
      },
      select,
      orderBy: { createdAt: 'desc' },
    });
    return assets;
  }

  async get(user: AuthenticatedPrincipal, assetId: string) {
    if (!this.has(user, PERMISSIONS.ASSET_READ))
      throw new ForbiddenException('Permission denied');
    const asset = await this.authorizedAsset(user, assetId);
    return {
      id: asset.id,
      organizationId: asset.organizationId,
      branchId: asset.branchId,
      originalName: asset.originalName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      status: asset.status,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
    };
  }

  async content(user: AuthenticatedPrincipal, assetId: string) {
    if (!this.has(user, PERMISSIONS.ASSET_READ))
      throw new ForbiddenException('Permission denied');
    const asset = await this.authorizedAsset(user, assetId);
    return { asset, stream: await this.storage.get(asset.storageKey) };
  }

  async upload(
    user: AuthenticatedPrincipal,
    file: UploadedFile | undefined,
    branchId?: string,
  ) {
    if (!this.has(user, PERMISSIONS.ASSET_MANAGE))
      throw new ForbiddenException('Permission denied');
    if (!file?.buffer?.length)
      throw new BadRequestException('An image file is required');
    if (file.size > maxBytes || file.buffer.length > maxBytes)
      throw new BadRequestException('Image must be 5 MB or smaller');
    const type = imageTypes[file.mimetype];
    if (!type || !type.matches(file.buffer))
      throw new BadRequestException(
        'Only valid PNG, JPEG, or WebP images are allowed',
      );
    if (branchId) await this.assertBranch(user, branchId);
    else if (!this.canManageOrganization(user))
      throw new ForbiddenException('Organization asset access denied');
    const originalName = cleanName(file.originalname);
    const storageKey = randomUUID() + type.extension;
    const imageDimensions = dimensions(file.mimetype, file.buffer);
    await this.storage.put(storageKey, file.buffer);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const asset = await tx.asset.create({
          data: {
            organizationId: user.organizationId,
            branchId: branchId ?? null,
            uploadedById: user.id,
            originalName,
            storageKey,
            mimeType: file.mimetype,
            sizeBytes: file.buffer.length,
            ...imageDimensions,
            checksumSha256: createHash('sha256')
              .update(file.buffer)
              .digest('hex'),
          },
          select,
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'asset.created',
          entityType: 'asset',
          entityId: asset.id,
          branchId: asset.branchId,
          metadata: { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes },
        });
        return asset;
      });
    } catch (error: unknown) {
      await this.storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  }

  async update(
    user: AuthenticatedPrincipal,
    assetId: string,
    input: { originalName?: string; branchId?: string | null },
  ) {
    if (!this.has(user, PERMISSIONS.ASSET_MANAGE))
      throw new ForbiddenException('Permission denied');
    const asset = await this.authorizedAsset(user, assetId);
    if (asset.branchId === null && !this.canManageOrganization(user))
      throw new ForbiddenException('Organization asset access denied');
    if (
      input.branchId !== undefined &&
      input.branchId !== asset.branchId &&
      (input.branchId === null || asset.branchId === null
        ? !this.canManageOrganization(user)
        : !this.has(user, PERMISSIONS.BRANCH_MANAGE))
    )
      throw new ForbiddenException('Asset scope cannot be changed');
    if (input.branchId) await this.assertBranch(user, input.branchId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.asset.update({
        where: { id: asset.id },
        data: {
          ...(input.originalName
            ? { originalName: cleanName(input.originalName) }
            : {}),
          ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
        },
        select,
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'asset.updated',
        entityType: 'asset',
        entityId: asset.id,
        branchId: input.branchId ?? asset.branchId,
        metadata: {
          fields: Object.keys(input).filter((key) => key !== 'originalName'),
        },
      });
      return updated;
    });
  }

  async remove(user: AuthenticatedPrincipal, assetId: string) {
    if (!this.has(user, PERMISSIONS.ASSET_MANAGE))
      throw new ForbiddenException('Permission denied');
    const asset = await this.authorizedAsset(user, assetId);
    if (asset.branchId === null && !this.canManageOrganization(user))
      throw new ForbiddenException('Organization asset access denied');
    await this.prisma.$transaction(async (tx) => {
      await tx.brandProfile.updateMany({
        where: { logoAssetId: asset.id },
        data: { logoAssetId: null },
      });
      await tx.branchBrandOverride.updateMany({
        where: { logoAssetId: asset.id },
        data: { logoAssetId: null },
      });
      await tx.asset.update({
        where: { id: asset.id },
        data: { status: 'DELETED', deletedAt: new Date() },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'asset.deleted',
        entityType: 'asset',
        entityId: asset.id,
        branchId: asset.branchId,
        metadata: { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes },
      });
    });
    await this.storage.remove(asset.storageKey).catch(() => undefined);
    return { id: asset.id, status: 'DELETED' as const };
  }
}

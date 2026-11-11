import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AssetInUseConflictResponse,
  AssetInUseReason,
  AssetUsageResponse,
} from '@adflow/shared-types';
import type { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  transactionConflictMessage,
  transactionContentionException,
} from '../prisma/transaction-errors';
import { lockActiveAssetForChange } from './asset-locks';
import {
  branchLogoWhere,
  findCreativeRevisionReferences,
  organizationLogoWhere,
} from './asset-references';
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
  // Only a real IHDR chunk carries the size; other bytes after the signature
  // would otherwise be reported as nonsense dimensions. PNG limits each
  // dimension to 1..2^31-1.
  if (
    type === 'image/png' &&
    data.length >= 24 &&
    data.toString('ascii', 12, 16) === 'IHDR'
  ) {
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width > 0 && height > 0 && width <= 0x7fffffff && height <= 0x7fffffff)
      return { width, height };
  }
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
// The 409 body names why deletion was refused so clients can explain it
// without parsing the message.
function assetInUse(
  reason: AssetInUseReason,
  message: string,
): ConflictException {
  const body: AssetInUseConflictResponse = {
    statusCode: 409,
    error: 'Conflict',
    message,
    reason,
  };
  return new ConflictException(body);
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

  // Branches whose details the caller may see, by the same rule as
  // assertBranch; null means every branch of the organization.
  private async accessibleBranchIds(
    user: AuthenticatedPrincipal,
  ): Promise<Set<string> | null> {
    if (this.has(user, PERMISSIONS.BRANCH_MANAGE)) return null;
    const grants = await this.prisma.userBranchAccess.findMany({
      where: {
        userId: user.id,
        branch: { organizationId: user.organizationId, status: 'ACTIVE' },
      },
      select: { branchId: true },
    });
    return new Set(grants.map((grant) => grant.branchId));
  }

  // Read-only: where the asset is used in the caller's organization, from the
  // same reference definitions that block deletion and branch moves. Takes
  // no locks and writes nothing. Deleted, unknown, and other organizations'
  // assets are not found, as for GET /assets/:assetId.
  async usage(
    user: AuthenticatedPrincipal,
    assetId: string,
  ): Promise<AssetUsageResponse> {
    if (!this.has(user, PERMISSIONS.ASSET_READ))
      throw new ForbiddenException('Permission denied');
    const asset = await this.authorizedAsset(user, assetId);
    const [revisions, organizationProfile, branchProfiles, visibleBranches] =
      await Promise.all([
        findCreativeRevisionReferences(
          this.prisma,
          user.organizationId,
          asset.id,
        ),
        this.prisma.brandProfile.findFirst({
          where: organizationLogoWhere(user.organizationId, asset.id),
          select: { id: true, displayName: true },
        }),
        this.prisma.branchBrandOverride.findMany({
          where: branchLogoWhere(user.organizationId, asset.id),
          select: {
            branchId: true,
            branch: { select: { name: true, code: true } },
          },
          orderBy: { branch: { name: 'asc' } },
        }),
        this.accessibleBranchIds(user),
      ]);
    const visible = (branchId: string) =>
      visibleBranches === null || visibleBranches.has(branchId);
    const shownRevisions = revisions.filter((revision) =>
      visible(revision.branchId),
    );
    const shownBranchProfiles = branchProfiles.filter((profile) =>
      visible(profile.branchId),
    );
    const fields = shownRevisions.some((revision) => revision.fieldKeys.length)
      ? await this.prisma.templateField.findMany({
          where: {
            OR: shownRevisions.map((revision) => ({
              versionId: revision.templateVersionId,
              key: { in: revision.fieldKeys },
            })),
          },
          select: { versionId: true, key: true, label: true, type: true },
        })
      : [];
    const fieldOf = (versionId: string, key: string) =>
      fields.find(
        (field) => field.versionId === versionId && field.key === key,
      );
    return {
      assetId: asset.id,
      inUse:
        revisions.length > 0 ||
        organizationProfile !== null ||
        branchProfiles.length > 0,
      creativeRevisions: shownRevisions.map((revision) => ({
        creativeId: revision.creativeId,
        creativeName: revision.creativeName,
        branchId: revision.branchId,
        branchName: revision.branchName,
        revisionId: revision.revisionId,
        revisionNumber: revision.revisionNumber,
        isCurrentRevision: revision.isCurrentRevision,
        fields: revision.fieldKeys.map((key) => {
          const field = fieldOf(revision.templateVersionId, key);
          return {
            key,
            label: field?.label ?? null,
            type: field?.type ?? null,
          };
        }),
      })),
      organizationBrandProfile: organizationProfile
        ? {
            profileId: organizationProfile.id,
            displayName: organizationProfile.displayName,
          }
        : null,
      branchBrandProfiles: shownBranchProfiles.map((profile) => ({
        branchId: profile.branchId,
        branchName: profile.branch.name,
        branchCode: profile.branch.code,
      })),
      hiddenReferenceCount:
        revisions.length -
        shownRevisions.length +
        (branchProfiles.length - shownBranchProfiles.length),
    };
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
    try {
      return { asset, stream: await this.storage.get(asset.storageKey) };
    } catch (error: unknown) {
      // The record is active but its file is gone; never expose the path.
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
        throw new NotFoundException('Asset content not found');
      throw error;
    }
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

  // Locks the asset row before a deletion or branch move. Reference writers
  // then wait (or fail) until this transaction ends, so no reference can
  // appear between the checks below and the write. Authorization ran on the
  // branch read before the transaction; if a concurrent move changed it, the
  // request is refused rather than applied under a stale scope.
  private async lockForChange(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    asset: { id: string; branchId: string | null },
  ): Promise<void> {
    const locked = await lockActiveAssetForChange(
      tx,
      user.organizationId,
      asset.id,
    );
    if (!locked) throw new NotFoundException('Asset not found');
    if (locked.branchId !== asset.branchId)
      throw new ConflictException(transactionConflictMessage);
  }

  // Refuses with 409 while anything in the caller's organization still uses
  // the asset: a retained creative revision (image and logo asset IDs are
  // top-level string values of its JSON field map), the organization brand
  // logo, or a branch brand logo. Runs under lockForChange, before any write
  // and before the stored file is touched.
  private async assertUnreferenced(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    assetId: string,
    refusal: string,
  ): Promise<void> {
    const references = await findCreativeRevisionReferences(
      tx,
      user.organizationId,
      assetId,
    );
    if (references.length > 0)
      throw assetInUse(
        'CREATIVE_REVISION',
        'Asset is used by a creative revision and ' + refusal,
      );
    const organizationLogo = await tx.brandProfile.findFirst({
      where: organizationLogoWhere(user.organizationId, assetId),
      select: { id: true },
    });
    if (organizationLogo)
      throw assetInUse(
        'ORGANIZATION_BRAND_LOGO',
        'Asset is used as the organization brand logo and ' + refusal,
      );
    const branchLogo = await tx.branchBrandOverride.findFirst({
      where: branchLogoWhere(user.organizationId, assetId),
      select: { id: true },
    });
    if (branchLogo)
      throw assetInUse(
        'BRANCH_BRAND_LOGO',
        'Asset is used as a branch brand logo and ' + refusal,
      );
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
    const moving =
      input.branchId !== undefined && input.branchId !== asset.branchId;
    if (
      moving &&
      (input.branchId === null || asset.branchId === null
        ? !this.canManageOrganization(user)
        : !this.has(user, PERMISSIONS.BRANCH_MANAGE))
    )
      throw new ForbiddenException('Asset scope cannot be changed');
    if (moving && input.branchId) await this.assertBranch(user, input.branchId);
    return this.prisma
      .$transaction(async (tx) => {
        // A move would strand every reference that relies on the current
        // scope, so it is refused while any exists. Renames take no lock.
        if (moving) {
          await this.lockForChange(tx, user, asset);
          await this.assertUnreferenced(
            tx,
            user,
            asset.id,
            'cannot be moved to another branch',
          );
        }
        const updated = await tx.asset.update({
          where: { id: asset.id },
          data: {
            ...(input.originalName
              ? { originalName: cleanName(input.originalName) }
              : {}),
            // Only a real move writes the branch: echoing the branch read
            // before the transaction could undo a concurrent move.
            ...(moving ? { branchId: input.branchId } : {}),
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
      })
      .catch((error: unknown) => {
        throw transactionContentionException(error) ?? error;
      });
  }

  async remove(user: AuthenticatedPrincipal, assetId: string) {
    if (!this.has(user, PERMISSIONS.ASSET_MANAGE))
      throw new ForbiddenException('Permission denied');
    const asset = await this.authorizedAsset(user, assetId);
    if (asset.branchId === null && !this.canManageOrganization(user))
      throw new ForbiddenException('Organization asset access denied');
    await this.prisma
      .$transaction(async (tx) => {
        await this.lockForChange(tx, user, asset);
        await this.assertUnreferenced(tx, user, asset.id, 'cannot be deleted');
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
      })
      .catch((error: unknown) => {
        throw transactionContentionException(error) ?? error;
      });
    await this.storage.remove(asset.storageKey).catch(() => undefined);
    return { id: asset.id, status: 'DELETED' as const };
  }
}

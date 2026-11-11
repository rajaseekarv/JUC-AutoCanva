import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockActiveAssetsForReference } from '../assets/asset-locks';
import { PrismaService } from '../prisma/prisma.service';
import { transactionContentionException } from '../prisma/transaction-errors';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { AuditService } from '../audit/audit.service';

const fields = [
  'displayName',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'fontFamily',
  'websiteUrl',
  'logoAssetId',
] as const;
// A transaction PostgreSQL rolled back for contention answers 409, not 500.
function rethrowContention(error: unknown): never {
  throw transactionContentionException(error) ?? error;
}

export type BrandInput = Partial<
  Record<(typeof fields)[number], string | null>
>;

@Injectable()
export class BrandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}
  private can(user: AuthenticatedPrincipal, permission: string): boolean {
    return user.permissions.includes(permission);
  }

  async organization(user: AuthenticatedPrincipal) {
    if (!this.can(user, PERMISSIONS.BRAND_READ))
      throw new ForbiddenException('Permission denied');
    const profile = await this.prisma.brandProfile.findUnique({
      where: { organizationId: user.organizationId },
    });
    return (
      profile ?? {
        organizationId: user.organizationId,
        displayName: null,
        primaryColor: null,
        secondaryColor: null,
        accentColor: null,
        fontFamily: null,
        websiteUrl: null,
        logoAssetId: null,
      }
    );
  }

  async updateOrganization(user: AuthenticatedPrincipal, input: BrandInput) {
    if (
      !this.can(user, PERMISSIONS.BRAND_MANAGE) ||
      !this.can(user, PERMISSIONS.ORGANIZATION_UPDATE)
    )
      throw new ForbiddenException('Permission denied');
    return this.prisma
      .$transaction(async (tx) => {
        await this.lockLogo(tx, user, input.logoAssetId, null);
        const profile = await tx.brandProfile.upsert({
          where: { organizationId: user.organizationId },
          create: { organizationId: user.organizationId, ...input },
          update: input,
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'brand_profile.updated',
          entityType: 'brand_profile',
          entityId: profile.id,
          metadata: {
            fields: Object.keys(input).filter((key) => key !== 'logoAssetId'),
          },
        });
        return profile;
      })
      .catch(rethrowContention);
  }

  private async branch(user: AuthenticatedPrincipal, branchId: string) {
    const canManage = this.can(user, PERMISSIONS.BRANCH_MANAGE);
    const branch = canManage
      ? await this.prisma.branch.findFirst({
          where: { id: branchId, organizationId: user.organizationId },
        })
      : await this.prisma.userBranchAccess
          .findFirst({
            where: {
              userId: user.id,
              branchId,
              branch: { organizationId: user.organizationId, status: 'ACTIVE' },
            },
            select: { branch: true },
          })
          .then((row) => row?.branch ?? null);
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  // Runs inside the write transaction, before the profile changes: the shared
  // row lock keeps the logo from being deleted until the new reference
  // commits (see lockActiveAssetsForReference). An organization profile may
  // only use organization-wide assets; a branch override may also use assets
  // attached to its own branch.
  private async lockLogo(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    assetId: string | null | undefined,
    branchId: string | null,
  ) {
    if (!assetId) return;
    const locked = await lockActiveAssetsForReference(
      tx,
      user.organizationId,
      branchId,
      [assetId],
    );
    if (!locked.has(assetId)) throw new NotFoundException('Asset not found');
  }

  async branchProfile(user: AuthenticatedPrincipal, branchId: string) {
    if (!this.can(user, PERMISSIONS.BRAND_READ))
      throw new ForbiddenException('Permission denied');
    await this.branch(user, branchId);
    const override = await this.prisma.branchBrandOverride.findUnique({
      where: { branchId },
    });
    return (
      override ?? {
        branchId,
        displayName: null,
        primaryColor: null,
        secondaryColor: null,
        accentColor: null,
        fontFamily: null,
        websiteUrl: null,
        logoAssetId: null,
      }
    );
  }

  async updateBranch(
    user: AuthenticatedPrincipal,
    branchId: string,
    input: BrandInput,
  ) {
    if (!this.can(user, PERMISSIONS.BRAND_MANAGE))
      throw new ForbiddenException('Permission denied');
    await this.branch(user, branchId);
    return this.prisma
      .$transaction(async (tx) => {
        await this.lockLogo(tx, user, input.logoAssetId, branchId);
        const override = await tx.branchBrandOverride.upsert({
          where: { branchId },
          create: { branchId, ...input },
          update: input,
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'branch_brand_override.updated',
          entityType: 'branch_brand_override',
          entityId: override.id,
          branchId,
          metadata: {
            fields: Object.keys(input).filter((key) => key !== 'logoAssetId'),
          },
        });
        return override;
      })
      .catch(rethrowContention);
  }

  async effective(user: AuthenticatedPrincipal, branchId: string) {
    if (!this.can(user, PERMISSIONS.BRAND_READ))
      throw new ForbiddenException('Permission denied');
    await this.branch(user, branchId);
    const [base, override] = await Promise.all([
      this.prisma.brandProfile.findUnique({
        where: { organizationId: user.organizationId },
      }),
      this.prisma.branchBrandOverride.findUnique({ where: { branchId } }),
    ]);
    const effective: Record<string, unknown> = {
      organizationId: user.organizationId,
      branchId,
    };
    for (const field of fields)
      effective[field] = override?.[field] ?? base?.[field] ?? null;
    effective.overriddenFields = fields.filter(
      (field) => override?.[field] !== null && override?.[field] !== undefined,
    );
    return effective;
  }
}

import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
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
    if (input.logoAssetId) await this.assertLogo(user, input.logoAssetId, null);
    return this.prisma.$transaction(async (tx) => {
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
    });
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

  private async assertLogo(
    user: AuthenticatedPrincipal,
    assetId: string,
    branchId: string | null,
  ) {
    const asset = await this.prisma.asset.findFirst({
      where: {
        id: assetId,
        organizationId: user.organizationId,
        status: 'ACTIVE',
      },
    });
    if (!asset || (asset.branchId !== null && asset.branchId !== branchId))
      throw new NotFoundException('Asset not found');
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
    if (input.logoAssetId)
      await this.assertLogo(user, input.logoAssetId, branchId);
    return this.prisma.$transaction(async (tx) => {
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
    });
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

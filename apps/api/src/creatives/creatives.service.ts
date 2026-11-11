import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TemplateStatus } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatesService } from '../templates/templates.service';
import { AuditService } from '../audit/audit.service';
import { lockActiveAssetsForReference } from '../assets/asset-locks';
import { transactionContentionException } from '../prisma/transaction-errors';
import {
  UNREVIEWED_REVISION_STATUS,
  withReviewState,
} from './creative-review-state';

type CreativeInput = {
  name: string;
  branchId: string;
  templateVersionId: string;
  values: Record<string, unknown>;
  campaignId?: string | null;
  summary?: string | null;
};

const detailInclude = {
  currentRevision: {
    include: {
      templateVersion: {
        include: { fields: { orderBy: { displayOrder: 'asc' as const } } },
      },
    },
  },
} satisfies Prisma.CreativeInclude;

@Injectable()
export class CreativesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly audit: AuditService,
  ) {}

  private require(user: AuthenticatedPrincipal, permission: string): void {
    if (!user.permissions.includes(permission))
      throw new ForbiddenException('Permission denied');
  }

  private async assertBranch(
    user: AuthenticatedPrincipal,
    branchId: string,
  ): Promise<void> {
    const branch = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? await this.prisma.branch.findFirst({
          where: {
            id: branchId,
            organizationId: user.organizationId,
            status: 'ACTIVE',
          },
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
    if (!branch) throw new NotFoundException('Branch not found');
  }

  private async assertCampaignTarget(
    user: AuthenticatedPrincipal,
    campaignId: string | null | undefined,
    branchId: string,
  ): Promise<void> {
    if (!campaignId) return;
    const assignment = await this.prisma.campaignBranch.findFirst({
      where: {
        campaignId,
        branchId,
        status: 'ASSIGNED',
        campaign: { organizationId: user.organizationId },
        branch: { organizationId: user.organizationId },
      },
      select: { id: true },
    });
    if (!assignment)
      throw new BadRequestException('Campaign is not assigned to this branch');
  }

  async list(user: AuthenticatedPrincipal, branchId?: string) {
    this.require(user, PERMISSIONS.CREATIVE_READ);
    if (branchId) await this.assertBranch(user, branchId);
    const permittedBranches = user.permissions.includes(
      PERMISSIONS.BRANCH_MANAGE,
    )
      ? await this.prisma.branch.findMany({
          where: {
            organizationId: user.organizationId,
            status: 'ACTIVE',
            ...(branchId ? { id: branchId } : {}),
          },
          select: { id: true },
        })
      : await this.prisma.userBranchAccess.findMany({
          where: {
            userId: user.id,
            branch: {
              organizationId: user.organizationId,
              status: 'ACTIVE',
              ...(branchId ? { id: branchId } : {}),
            },
          },
          select: { branchId: true },
        });
    const ids = permittedBranches.map((item) =>
      'id' in item ? item.id : item.branchId,
    );
    if (branchId && !ids.includes(branchId))
      throw new NotFoundException('Branch not found');
    const creatives = await this.prisma.creative.findMany({
      where: { organizationId: user.organizationId, branchId: { in: ids } },
      include: {
        ...detailInclude,
        branch: { select: { id: true, name: true, code: true } },
        campaign: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return withReviewState(this.prisma, user.organizationId, creatives);
  }

  // Revision writes run SERIALIZABLE. A transaction PostgreSQL rolls back
  // for contention (for example, an asset deleted while this one waited on
  // its row lock) answers 409 instead of 500; nothing was written.
  private async serializable<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error: unknown) {
      throw transactionContentionException(error) ?? error;
    }
  }

  // Validation ran before the transaction; re-check the referenced assets
  // under a shared row lock so none can be deleted before this revision
  // commits (see lockActiveAssetsForReference).
  private async lockReferencedAssets(
    tx: Prisma.TransactionClient,
    user: AuthenticatedPrincipal,
    branchId: string,
    assetIds: readonly string[],
  ): Promise<void> {
    const locked = await lockActiveAssetsForReference(
      tx,
      user.organizationId,
      branchId,
      assetIds,
    );
    if (assetIds.some((assetId) => !locked.has(assetId)))
      throw new BadRequestException('Select an in-scope active image asset');
  }

  async get(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.CREATIVE_READ);
    const creative = await this.prisma.creative.findFirst({
      where: { id, organizationId: user.organizationId },
      include: detailInclude,
    });
    if (!creative) throw new NotFoundException('Creative not found');
    await this.assertBranch(user, creative.branchId);
    const [withState] = await withReviewState(
      this.prisma,
      user.organizationId,
      [creative],
    );
    return withState;
  }

  async create(user: AuthenticatedPrincipal, input: CreativeInput) {
    this.require(user, PERMISSIONS.CREATIVE_CREATE);
    await this.assertBranch(user, input.branchId);
    await this.assertCampaignTarget(user, input.campaignId, input.branchId);
    const validated = await this.templates.validateCreativeValues(
      user,
      input.branchId,
      input.templateVersionId,
      input.values,
    );
    return this.serializable(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: {
          id: input.branchId,
          organizationId: user.organizationId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Branch not found');
      if (!user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)) {
        const grant = await tx.userBranchAccess.findFirst({
          where: { userId: user.id, branchId: input.branchId },
          select: { branchId: true },
        });
        if (!grant) throw new NotFoundException('Branch not found');
      }
      if (input.campaignId) {
        const assignment = await tx.campaignBranch.findFirst({
          where: {
            campaignId: input.campaignId,
            branchId: input.branchId,
            status: 'ASSIGNED',
            campaign: { organizationId: user.organizationId },
            branch: { organizationId: user.organizationId },
          },
          select: { id: true },
        });
        if (!assignment)
          throw new BadRequestException(
            'Campaign is not assigned to this branch',
          );
      }
      const version = await tx.templateVersion.findFirst({
        where: {
          id: validated.versionId,
          immutableAt: { not: null },
          template: {
            organizationId: user.organizationId,
            status: TemplateStatus.ACTIVE,
          },
        },
        include: { template: true },
      });
      if (
        !version ||
        version.template.activeVersionNumber !== version.versionNumber
      )
        throw new ConflictException('Template version is no longer active');
      await this.lockReferencedAssets(
        tx,
        user,
        input.branchId,
        validated.assetIds,
      );
      const creative = await tx.creative.create({
        data: {
          organizationId: user.organizationId,
          branchId: input.branchId,
          campaignId: input.campaignId ?? null,
          name: input.name,
          createdById: user.id,
          updatedById: user.id,
        },
      });
      const revision = await tx.creativeRevision.create({
        data: {
          creativeId: creative.id,
          revisionNumber: 1,
          templateVersionId: version.id,
          values: validated.values,
          summary: input.summary ?? null,
          createdById: user.id,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'creative.created',
        entityType: 'creative',
        entityId: creative.id,
        branchId: creative.branchId,
        creativeId: creative.id,
        creativeRevisionId: revision.id,
        metadata: {
          revisionNumber: revision.revisionNumber,
          templateVersionId: version.id,
        },
      });
      const created = await tx.creative.update({
        where: { id: creative.id },
        data: { currentRevisionId: revision.id },
        include: detailInclude,
      });
      // A new creative has no runs or decisions yet.
      return {
        ...created,
        approvedRevision: null,
        currentRevisionApproved: false,
      };
    });
  }

  async update(
    user: AuthenticatedPrincipal,
    id: string,
    input: {
      name?: string;
      templateVersionId?: string;
      values?: Record<string, unknown>;
      summary?: string | null;
    },
  ) {
    this.require(user, PERMISSIONS.CREATIVE_UPDATE);
    const creative = await this.prisma.creative.findFirst({
      where: { id, organizationId: user.organizationId },
      include: detailInclude,
    });
    if (!creative || !creative.currentRevision)
      throw new NotFoundException('Creative not found');
    await this.assertBranch(user, creative.branchId);
    const templateVersionId =
      input.templateVersionId ?? creative.currentRevision.templateVersionId;
    const sourceValues = input.values ?? creative.currentRevision.values;
    if (
      !sourceValues ||
      typeof sourceValues !== 'object' ||
      Array.isArray(sourceValues)
    )
      throw new BadRequestException('Creative values must be an object');
    const validated = await this.templates.validateCreativeValues(
      user,
      creative.branchId,
      templateVersionId,
      sourceValues as Record<string, unknown>,
      creative.currentRevision.templateVersionId,
    );
    return this.serializable(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: {
          id: creative.branchId,
          organizationId: user.organizationId,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Creative not found');
      const activeWorkflow = await tx.workflowInstance.findFirst({
        where: { creativeId: id, status: 'RUNNING' },
        select: { id: true },
      });
      if (activeWorkflow)
        throw new ConflictException(
          'Creative revisions cannot change while a workflow is running',
        );
      if (!user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)) {
        const grant = await tx.userBranchAccess.findFirst({
          where: { userId: user.id, branchId: creative.branchId },
          select: { branchId: true },
        });
        if (!grant) throw new NotFoundException('Creative not found');
      }
      const version = await tx.templateVersion.findFirst({
        where: {
          id: validated.versionId,
          immutableAt: { not: null },
          template: { organizationId: user.organizationId },
        },
        include: { template: true },
      });
      if (
        !version ||
        (version.id !== creative.currentRevision!.templateVersionId &&
          (version.template.status !== TemplateStatus.ACTIVE ||
            version.template.activeVersionNumber !== version.versionNumber))
      )
        throw new ConflictException(
          'A changed template version must be active',
        );
      await this.lockReferencedAssets(
        tx,
        user,
        creative.branchId,
        validated.assetIds,
      );
      const latest = await tx.creativeRevision.findFirst({
        where: { creativeId: id },
        orderBy: { revisionNumber: 'desc' },
        select: { revisionNumber: true },
      });
      const revision = await tx.creativeRevision.create({
        data: {
          creativeId: id,
          revisionNumber: (latest?.revisionNumber ?? 0) + 1,
          templateVersionId: version.id,
          values: validated.values,
          summary: input.summary ?? null,
          createdById: user.id,
        },
      });
      await tx.creative.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          updatedById: user.id,
          currentRevisionId: revision.id,
          // The status described the revision the last run reviewed; the
          // new revision has not entered a workflow. Decisions are kept.
          status: UNREVIEWED_REVISION_STATUS,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'creative.revised',
        entityType: 'creative',
        entityId: id,
        branchId: creative.branchId,
        creativeId: id,
        creativeRevisionId: revision.id,
        metadata: {
          revisionNumber: revision.revisionNumber,
          templateVersionId: version.id,
          previousStatus: creative.status,
          status: UNREVIEWED_REVISION_STATUS,
        },
      });
      const revised = await tx.creative.findUniqueOrThrow({
        where: { id },
        include: detailInclude,
      });
      const [withState] = await withReviewState(tx, user.organizationId, [
        revised,
      ]);
      return withState;
    });
  }

  async revisions(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.CREATIVE_READ);
    const creative = await this.prisma.creative.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { branchId: true },
    });
    if (!creative) throw new NotFoundException('Creative not found');
    await this.assertBranch(user, creative.branchId);
    return this.prisma.creativeRevision.findMany({
      where: { creativeId: id },
      include: {
        templateVersion: {
          include: { fields: { orderBy: { displayOrder: 'asc' } } },
        },
      },
      orderBy: { revisionNumber: 'desc' },
    });
  }

  async revision(
    user: AuthenticatedPrincipal,
    id: string,
    revisionNumber: number,
  ) {
    this.require(user, PERMISSIONS.CREATIVE_READ);
    const creative = await this.prisma.creative.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { branchId: true },
    });
    if (!creative) throw new NotFoundException('Creative not found');
    await this.assertBranch(user, creative.branchId);
    const revision = await this.prisma.creativeRevision.findUnique({
      where: { creativeId_revisionNumber: { creativeId: id, revisionNumber } },
      include: {
        templateVersion: {
          include: { fields: { orderBy: { displayOrder: 'asc' } } },
        },
      },
    });
    if (!revision) throw new NotFoundException('Creative revision not found');
    return revision;
  }
}

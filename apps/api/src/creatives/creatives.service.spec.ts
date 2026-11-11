import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import type { TemplatesService } from '../templates/templates.service';
import { CreativesService } from './creatives.service';
import { transactionConflictMessage } from '../prisma/transaction-errors';

const principal: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  name: 'Branch user',
  email: 'branch@example.local',
  branches: [],
  permissions: [
    PERMISSIONS.CREATIVE_READ,
    PERMISSIONS.CREATIVE_CREATE,
    PERMISSIONS.CREATIVE_UPDATE,
  ],
};
const creative = {
  id: 'creative-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  name: 'Spring',
  // Stage of the latest run, which approved revision 1.
  status: 'approved',
  currentRevisionId: 'revision-1',
  currentRevision: {
    id: 'revision-1',
    creativeId: 'creative-1',
    revisionNumber: 1,
    templateVersionId: 'version-1',
    values: { headline: 'Hello' },
  },
};

function setup() {
  const tx = {
    // Asset lock query: returns the IDs it locked.
    $queryRaw: vi.fn().mockResolvedValue([] as Array<{ id: string }>),
    workflowInstance: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    approvalDecision: { findMany: vi.fn().mockResolvedValue([]) },
    branch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }) },
    userBranchAccess: {
      findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
    },
    campaignBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
    },
    templateVersion: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'version-1',
        versionNumber: 1,
        template: { activeVersionNumber: 1 },
      }),
    },
    creative: {
      create: vi.fn().mockResolvedValue({ id: 'creative-1' }),
      update: vi.fn().mockResolvedValue(creative),
      findUniqueOrThrow: vi.fn().mockResolvedValue(creative),
    },
    creativeRevision: {
      create: vi
        .fn()
        .mockResolvedValue({ id: 'revision-2', revisionNumber: 2 }),
      findFirst: vi.fn().mockResolvedValue({ revisionNumber: 1 }),
    },
  };
  const prisma = {
    branch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    userBranchAccess: {
      findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }),
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
    },
    campaignBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
    },
    creative: {
      findFirst: vi.fn().mockResolvedValue(creative),
      findMany: vi.fn().mockResolvedValue([]),
    },
    creativeRevision: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    approvalDecision: { findMany: vi.fn().mockResolvedValue([]) },
    workflowInstance: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const templates = {
    validateCreativeValues: vi.fn().mockResolvedValue({
      versionId: 'version-1',
      values: { headline: 'Hello' },
      assetIds: [] as string[],
    }),
  };
  const audit = { write: vi.fn().mockResolvedValue({ id: 'audit-1' }) };
  return {
    service: new CreativesService(
      prisma as unknown as PrismaService,
      templates as unknown as TemplatesService,
      audit as never,
    ),
    prisma,
    tx,
    templates,
    audit,
  };
}

// Regression (Stage 11 E2E): a creative approved on revision 3 kept showing
// "Approved" after revision 4 was saved, although revision 4 was never
// reviewed.
describe('CreativesService revision-specific approval', () => {
  const approvalOfRevision1 = {
    creativeId: 'creative-1',
    creativeRevisionId: 'revision-1',
    revisionNumber: 1,
    workflowInstanceId: 'run-1',
    decision: 'APPROVED',
    createdAt: new Date('2026-11-10T10:00:00Z'),
    reviewer: { id: 'reviewer-1', name: 'Rita Reviewer' },
  };

  it('resets the status to DRAFT when a revision is saved and records the previous status', async () => {
    const { service, tx, audit } = setup();
    await service.update(principal, 'creative-1', {
      values: { headline: 'Revised' },
    });
    expect(tx.creative.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentRevisionId: 'revision-2',
          status: 'DRAFT',
        }),
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'creative.revised',
        metadata: expect.objectContaining({
          revisionNumber: 2,
          previousStatus: 'approved',
          status: 'DRAFT',
        }),
      }),
    );
  });

  it('returns the approved older revision, and the current revision as not approved, after a revision save', async () => {
    const { service, tx } = setup();
    tx.creative.findUniqueOrThrow.mockResolvedValueOnce({
      ...creative,
      status: 'DRAFT',
      currentRevisionId: 'revision-2',
    });
    tx.approvalDecision.findMany.mockResolvedValueOnce([approvalOfRevision1]);
    tx.workflowInstance.findMany.mockResolvedValueOnce([
      {
        id: 'run-1',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-1',
        status: 'COMPLETED',
      },
    ]);
    const saved = await service.update(principal, 'creative-1', {
      values: { headline: 'Revised' },
    });
    expect(saved).toMatchObject({
      status: 'DRAFT',
      currentRevisionApproved: false,
      approvedRevision: {
        revisionId: 'revision-1',
        revisionNumber: 1,
        reviewer: { name: 'Rita Reviewer' },
      },
    });
  });

  it('reports an existing stale "approved" status as DRAFT when the latest finished run reviewed an older revision', async () => {
    const { service, prisma } = setup();
    prisma.creative.findFirst.mockResolvedValueOnce({
      ...creative,
      status: 'approved',
      currentRevisionId: 'revision-2',
    });
    prisma.approvalDecision.findMany.mockResolvedValueOnce([
      approvalOfRevision1,
    ]);
    prisma.workflowInstance.findMany.mockResolvedValueOnce([
      {
        id: 'run-1',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-1',
        status: 'COMPLETED',
      },
    ]);
    await expect(service.get(principal, 'creative-1')).resolves.toMatchObject({
      status: 'DRAFT',
      currentRevisionApproved: false,
      approvedRevision: { revisionNumber: 1 },
    });
  });

  it('keeps the approved status when the current revision is the approved one', async () => {
    const { service, prisma } = setup();
    prisma.approvalDecision.findMany.mockResolvedValueOnce([
      approvalOfRevision1,
    ]);
    prisma.workflowInstance.findMany.mockResolvedValueOnce([
      {
        id: 'run-1',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-1',
        status: 'COMPLETED',
      },
    ]);
    await expect(service.get(principal, 'creative-1')).resolves.toMatchObject({
      status: 'approved',
      currentRevisionApproved: true,
      approvedRevision: { revisionNumber: 1 },
    });
  });

  it('does not report approval from an earlier review stage while the run is still running', async () => {
    const { service, prisma } = setup();
    prisma.creative.findFirst.mockResolvedValueOnce({
      ...creative,
      status: 'legal-review',
    });
    prisma.approvalDecision.findMany.mockResolvedValueOnce([
      approvalOfRevision1,
    ]);
    prisma.workflowInstance.findMany.mockResolvedValueOnce([
      {
        id: 'run-1',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-1',
        status: 'RUNNING',
      },
    ]);
    await expect(service.get(principal, 'creative-1')).resolves.toMatchObject({
      status: 'legal-review',
      currentRevisionApproved: false,
      approvedRevision: null,
    });
  });

  it('loads every run, not only the latest, so an older completed approval is still found', async () => {
    const { service, prisma } = setup();
    await service.get(principal, 'creative-1');
    const query = prisma.workflowInstance.findMany.mock.calls[0]![0] as {
      distinct?: unknown;
      select: Record<string, boolean>;
    };
    expect(query.distinct).toBeUndefined();
    expect(query.select).toMatchObject({ id: true, status: true });
    expect(prisma.approvalDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ workflowInstanceId: true }),
      }),
    );
  });

  it('adds review state to a whole list with two organization-scoped queries', async () => {
    const { service, prisma } = setup();
    prisma.creative.findMany.mockResolvedValueOnce([
      creative,
      { ...creative, id: 'creative-2', currentRevisionId: 'revision-9' },
    ]);
    const list = await service.list(principal);
    expect(list).toHaveLength(2);
    expect(prisma.approvalDecision.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.workflowInstance.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.approvalDecision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          creativeId: { in: ['creative-1', 'creative-2'] },
        },
      }),
    );
    expect(list[1]).toMatchObject({
      approvedRevision: null,
      currentRevisionApproved: false,
    });
  });
});

describe('CreativesService', () => {
  it('hides creatives outside the authenticated organization', async () => {
    const { service, prisma } = setup();
    vi.mocked(prisma.creative.findFirst).mockResolvedValueOnce(null);
    await expect(
      service.get(principal, 'other-org-creative'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('blocks ID access when the user has no grant to the creative branch', async () => {
    const { service, prisma } = setup();
    vi.mocked(prisma.userBranchAccess.findFirst).mockResolvedValueOnce(null);
    await expect(service.get(principal, 'creative-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates the first revision and advances the current-revision pointer transactionally', async () => {
    const { service, tx, templates, audit } = setup();
    await service.create(principal, {
      name: 'Spring',
      branchId: 'branch-1',
      templateVersionId: 'version-1',
      values: { headline: 'Hello' },
    });
    expect(templates.validateCreativeValues).toHaveBeenCalledWith(
      principal,
      'branch-1',
      'version-1',
      { headline: 'Hello' },
    );
    expect(audit.write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'creative.created',
        organizationId: principal.organizationId,
        actorUserId: principal.id,
        entityId: 'creative-1',
      }),
    );
    expect(tx.creativeRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          revisionNumber: 1,
          templateVersionId: 'version-1',
        }),
      }),
    );
    expect(tx.creative.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentRevisionId: 'revision-2' }),
      }),
    );
  });

  it('creates against the active version while a newer template draft exists', async () => {
    const { service, tx } = setup();
    // ACTIVE template on frozen v1 with an unfrozen draft v2 in progress.
    const template = {
      status: 'ACTIVE',
      activeVersionNumber: 1,
      currentVersionNumber: 2,
    };
    vi.mocked(tx.templateVersion.findFirst).mockResolvedValueOnce({
      id: 'version-1',
      versionNumber: 1,
      template,
    });
    await service.create(principal, {
      name: 'Spring',
      branchId: 'branch-1',
      templateVersionId: 'version-1',
      values: { headline: 'Hello' },
    });
    expect(tx.templateVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'version-1',
          immutableAt: { not: null },
          template: { organizationId: 'org-1', status: 'ACTIVE' },
        }),
      }),
    );
    expect(tx.creativeRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ templateVersionId: 'version-1' }),
      }),
    );

    tx.creative.create.mockClear();
    vi.mocked(tx.templateVersion.findFirst).mockResolvedValueOnce({
      id: 'version-0',
      versionNumber: 0,
      template,
    });
    await expect(
      service.create(principal, {
        name: 'Stale',
        branchId: 'branch-1',
        templateVersionId: 'version-0',
        values: {},
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.creative.create).not.toHaveBeenCalled();
  });

  it('aborts a creative mutation when its transactional audit write fails', async () => {
    const { service, tx, audit } = setup();
    audit.write.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      service.create(principal, {
        name: 'Spring',
        branchId: 'branch-1',
        templateVersionId: 'version-1',
        values: { headline: 'Hello' },
      }),
    ).rejects.toThrow('audit unavailable');
    expect(tx.creative.create).toHaveBeenCalledOnce();
    expect(tx.creative.update).not.toHaveBeenCalled();
  });

  it('creates the next immutable revision without updating the prior revision row', async () => {
    const { service, tx } = setup();
    await service.update(principal, 'creative-1', {
      values: { headline: 'Updated' },
      summary: 'Copy update',
    });
    expect(tx.creativeRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revisionNumber: 2 }),
      }),
    );
    expect(tx.creative.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentRevisionId: 'revision-2' }),
      }),
    );
    expect(tx.creativeRevision).not.toHaveProperty('update');
    expect(tx.creativeRevision).not.toHaveProperty('delete');
  });

  it('prevents creative revision changes while a workflow tracks its current revision', async () => {
    const { service, tx } = setup();
    tx.workflowInstance.findFirst.mockResolvedValueOnce({
      id: 'workflow-instance-1',
    });
    await expect(
      service.update(principal, 'creative-1', {
        values: { headline: 'Changed' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.creativeRevision.create).not.toHaveBeenCalled();
  });

  it('rejects missing creative permissions before reading data', async () => {
    const { service, prisma } = setup();
    await expect(
      service.list({ ...principal, permissions: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.creative.findMany).not.toHaveBeenCalled();
  });

  it('verifies an optional campaign targets the selected branch', async () => {
    const { service, prisma } = setup();
    vi.mocked(prisma.campaignBranch.findFirst).mockResolvedValueOnce(null);
    await expect(
      service.create(principal, {
        name: 'Spring',
        branchId: 'branch-1',
        templateVersionId: 'version-1',
        values: {},
        campaignId: 'campaign-1',
      }),
    ).rejects.toThrow('Campaign is not assigned to this branch');
  });

  describe('referenced asset locking', () => {
    const withAssets = (
      context: ReturnType<typeof setup>,
      assetIds: string[],
      lockedIds: string[],
    ) => {
      vi.mocked(context.templates.validateCreativeValues).mockResolvedValue({
        versionId: 'version-1',
        values: { logo: assetIds[0] ?? null, hero: assetIds[1] ?? null },
        assetIds,
      });
      vi.mocked(context.tx.$queryRaw).mockResolvedValue(
        lockedIds.map((id) => ({ id })),
      );
    };
    const lockCall = (context: ReturnType<typeof setup>) => {
      const [strings, ...values] = vi.mocked(context.tx.$queryRaw).mock
        .calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      return Prisma.sql(strings, ...values);
    };
    const createInput = {
      name: 'Spring',
      branchId: 'branch-1',
      templateVersionId: 'version-1',
      values: {},
    };

    it('share-locks referenced assets in the creation transaction before writing', async () => {
      const context = setup();
      withAssets(context, ['asset-b', 'asset-a'], ['asset-a', 'asset-b']);
      await context.service.create(principal, createInput);
      const lock = lockCall(context);
      expect(lock.sql).toMatch(/FOR SHARE\s*$/);
      expect(lock.values).toEqual(
        expect.arrayContaining(['asset-a', 'asset-b', 'org-1', 'branch-1']),
      );
      expect(
        vi.mocked(context.tx.$queryRaw).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(context.tx.creative.create).mock.invocationCallOrder[0] ??
          -Infinity,
      );
    });

    it('rejects creation without writes when an asset was deleted after validation', async () => {
      const context = setup();
      withAssets(context, ['asset-a', 'asset-b'], ['asset-a']);
      await expect(
        context.service.create(principal, createInput),
      ).rejects.toThrow('Select an in-scope active image asset');
      expect(context.tx.creative.create).not.toHaveBeenCalled();
      expect(context.tx.creativeRevision.create).not.toHaveBeenCalled();
      expect(context.audit.write).not.toHaveBeenCalled();
    });

    it('share-locks the assets of a new revision before writing it', async () => {
      const context = setup();
      withAssets(context, ['asset-a'], ['asset-a']);
      await context.service.update(principal, 'creative-1', {
        values: { logo: 'asset-a' },
      });
      expect(lockCall(context).values).toEqual(
        expect.arrayContaining(['asset-a', 'org-1', 'branch-1']),
      );
      expect(
        vi.mocked(context.tx.$queryRaw).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(context.tx.creativeRevision.create).mock
          .invocationCallOrder[0] ?? -Infinity,
      );
    });

    it('rejects a revision without writes when an asset was deleted after validation', async () => {
      const context = setup();
      withAssets(context, ['asset-a'], []);
      await expect(
        context.service.update(principal, 'creative-1', {
          values: { logo: 'asset-a' },
        }),
      ).rejects.toThrow('Select an in-scope active image asset');
      expect(context.tx.creativeRevision.create).not.toHaveBeenCalled();
      expect(context.tx.creative.update).not.toHaveBeenCalled();
    });

    it('takes no asset lock for a revision without image or logo values', async () => {
      const context = setup();
      await context.service.update(principal, 'creative-1', { name: 'New' });
      expect(context.tx.$queryRaw).not.toHaveBeenCalled();
      expect(context.tx.creativeRevision.create).toHaveBeenCalled();
    });
  });

  describe('transaction contention', () => {
    const serializationFailure = () =>
      new Prisma.PrismaClientKnownRequestError('Raw query failed', {
        code: 'P2010',
        clientVersion: 'test',
        meta: {
          code: '40001',
          message: 'could not serialize access due to concurrent update',
        },
      });

    it('answers 409 when the asset lock fails to serialize behind a deletion', async () => {
      const context = setup();
      vi.mocked(context.prisma.$transaction).mockRejectedValueOnce(
        serializationFailure(),
      );
      const result = context.service.create(principal, {
        name: 'Spring',
        branchId: 'branch-1',
        templateVersionId: 'version-1',
        values: {},
      });
      await expect(result).rejects.toBeInstanceOf(ConflictException);
      await expect(result).rejects.toThrow(transactionConflictMessage);
    });

    it('answers 409 for a revision rolled back the same way, and keeps SERIALIZABLE', async () => {
      const context = setup();
      vi.mocked(context.prisma.$transaction).mockRejectedValueOnce(
        serializationFailure(),
      );
      await expect(
        context.service.update(principal, 'creative-1', { name: 'New' }),
      ).rejects.toThrow(transactionConflictMessage);
      expect(context.prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { isolationLevel: 'Serializable' },
      );
    });

    it('still rethrows unrelated failures unchanged', async () => {
      const context = setup();
      const failure = new Error('unrelated');
      vi.mocked(context.prisma.$transaction).mockRejectedValueOnce(failure);
      await expect(
        context.service.update(principal, 'creative-1', { name: 'New' }),
      ).rejects.toBe(failure);
    });
  });
});

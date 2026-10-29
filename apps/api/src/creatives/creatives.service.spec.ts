import { describe, expect, it, vi } from 'vitest';
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
    workflowInstance: { findFirst: vi.fn().mockResolvedValue(null) },
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
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const templates = {
    validateCreativeValues: vi.fn().mockResolvedValue({
      versionId: 'version-1',
      values: { headline: 'Hello' },
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
});

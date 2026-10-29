import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  Prisma,
  TemplateDataSource,
  TemplateFieldType,
  TemplateStatus,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { PrismaService } from '../prisma/prisma.service';
import type { BrandService } from '../brand/brand.service';
import type { AssetsService } from '../assets/assets.service';
import { AuditService } from '../audit/audit.service';
import {
  transactionConflictMessage,
  transactionUnconfirmedMessage,
} from '../prisma/transaction-errors';
import { TemplatesService } from './templates.service';

const principal: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  email: 'admin@example.local',
  name: 'Admin',
  branches: [],
  permissions: [
    PERMISSIONS.TEMPLATE_READ,
    PERMISSIONS.TEMPLATE_CREATE,
    PERMISSIONS.TEMPLATE_EDIT,
    PERMISSIONS.TEMPLATE_ACTIVATE,
    PERMISSIONS.TEMPLATE_ARCHIVE,
    PERMISSIONS.BRANCH_MANAGE,
    PERMISSIONS.BRAND_READ,
  ],
};
const draft = {
  id: 'template-1',
  organizationId: 'org-1',
  status: TemplateStatus.DRAFT,
  currentVersionNumber: 1,
  width: 1080,
  height: 1080,
  code: 'social',
  name: 'Social',
  formatName: 'Square',
  description: null,
  category: null,
  unit: 'PX',
};
const version = {
  id: 'version-1',
  templateId: 'template-1',
  versionNumber: 1,
  name: 'Social',
  description: null,
  category: null,
  formatName: 'Square',
  width: 1080,
  height: 1080,
  unit: 'PX',
  immutableAt: null,
  fields: [],
};

function createService(overrides: Record<string, unknown> = {}) {
  const prisma = {
    template: {
      findFirst: vi.fn().mockResolvedValue(draft),
      // The template row as re-read under the lock.
      findUniqueOrThrow: vi.fn().mockResolvedValue(draft),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    templateVersion: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(version),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // The conditional freeze: one row means the version was still a draft.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    templateField: {
      create: vi.fn(async ({ data }: { data: object }) => ({
        id: 'field-created',
        ...data,
      })),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(1),
    },
    userBranchAccess: { findFirst: vi.fn() },
    branch: { findFirst: vi.fn() },
    asset: { findFirst: vi.fn() },
    // Draft-version row lock: one row means the version is still mutable.
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'version-1' }]),
    $transaction: vi.fn(),
    ...overrides,
  };
  prisma.$transaction.mockImplementation(async (operation: unknown) =>
    typeof operation === 'function'
      ? (operation as (tx: unknown) => unknown)({
          template: prisma.template,
          templateVersion: prisma.templateVersion,
          templateField: prisma.templateField,
          $queryRaw: prisma.$queryRaw,
          auditLog: { create: vi.fn() },
        })
      : Promise.all(operation as Promise<unknown>[]),
  );
  return {
    prisma,
    service: new TemplatesService(
      prisma as unknown as PrismaService,
      {} as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    ),
  };
}

describe('TemplatesService', () => {
  it('validates required fields, primitive types, and unknown keys against the immutable version', async () => {
    const fixed = {
      ...version,
      immutableAt: new Date(),
      template: { status: TemplateStatus.ACTIVE, activeVersionNumber: 1 },
      fields: [
        {
          id: 'field-1',
          key: 'headline',
          label: 'Headline',
          type: TemplateFieldType.TEXT,
          required: true,
          defaultValue: null,
          validationRules: { minLength: 2 },
          dataSource: null,
          sourceKey: null,
        },
        {
          id: 'field-2',
          key: 'count',
          label: 'Count',
          type: TemplateFieldType.NUMBER,
          required: false,
          defaultValue: 1,
          validationRules: { min: 1 },
          dataSource: null,
          sourceKey: null,
        },
      ],
    };
    const { service } = createService({
      templateVersion: { findFirst: vi.fn().mockResolvedValue(fixed) },
    });
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {}),
    ).rejects.toThrow('Headline is required');
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {
        headline: 'ok',
        extra: true,
      }),
    ).rejects.toThrow('unknown template fields');
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {
        headline: 'ok',
        count: '2',
      }),
    ).rejects.toThrow('Count must be a number');
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {
        headline: 'ok',
        count: 2,
      }),
    ).resolves.toMatchObject({ values: { headline: 'ok', count: 2 } });
  });

  it('rejects whitespace-only required text but keeps valid values untrimmed', async () => {
    const fixed = {
      ...version,
      immutableAt: new Date(),
      template: { status: TemplateStatus.ACTIVE, activeVersionNumber: 1 },
      fields: [
        {
          id: 'field-1',
          key: 'headline',
          label: 'Headline',
          type: TemplateFieldType.TEXT,
          required: true,
          defaultValue: 'Default headline',
          validationRules: null,
          dataSource: null,
          sourceKey: null,
        },
      ],
    };
    const { service } = createService({
      templateVersion: { findFirst: vi.fn().mockResolvedValue(fixed) },
    });
    for (const blank of ['', '   ', '\t\n', null])
      await expect(
        service.validateCreativeValues(principal, 'branch-1', 'version-1', {
          headline: blank,
        }),
      ).rejects.toThrow('Headline is required');
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {
        headline: '  Sale  ',
      }),
    ).resolves.toMatchObject({ values: { headline: '  Sale  ' } });
  });

  it('requires a currently active version for a new creative but retains the selected archived version for edits', async () => {
    const archived = {
      ...version,
      immutableAt: new Date(),
      template: { status: TemplateStatus.ARCHIVED, activeVersionNumber: null },
      fields: [],
    };
    const { service } = createService({
      templateVersion: { findFirst: vi.fn().mockResolvedValue(archived) },
    });
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {}),
    ).rejects.toThrow('active template version');
    await expect(
      service.validateCreativeValues(
        principal,
        'branch-1',
        'version-1',
        {},
        'version-1',
      ),
    ).resolves.toMatchObject({ versionId: 'version-1', values: {} });
  });

  it('rejects organization access when the template belongs to another organization', async () => {
    const { service } = createService({
      template: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(service.get(principal, 'foreign-template')).rejects.toThrow(
      'Template not found',
    );
  });

  it('requires the narrow create permission', async () => {
    const { prisma, service } = createService({
      template: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const reader = { ...principal, permissions: [PERMISSIONS.TEMPLATE_READ] };
    await expect(
      service.create(reader, {
        name: 'T',
        code: 't1',
        formatName: 'Square',
        width: 10,
        height: 10,
      }),
    ).rejects.toThrow('Permission denied');
    expect(prisma.template.create).not.toHaveBeenCalled();
  });

  it('rejects invalid dimensions before persistence', async () => {
    const { prisma, service } = createService();
    await expect(
      service.create(principal, {
        name: 'T',
        code: 't1',
        formatName: 'Square',
        width: 50000,
        height: 50000,
      }),
    ).rejects.toThrow('Format dimensions');
    expect(prisma.template.create).not.toHaveBeenCalled();
  });

  it('creates a new organization-scoped template with draft version one', async () => {
    const { prisma, service } = createService({
      template: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'new-template' }),
        update: vi.fn(),
      },
    });
    await service.create(principal, {
      name: 'Poster',
      code: 'poster',
      formatName: 'Portrait',
      width: 900,
      height: 1200,
    });
    expect(prisma.template.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org-1',
          createdById: 'user-1',
          updatedById: 'user-1',
          versions: {
            create: expect.objectContaining({
              versionNumber: 1,
              createdById: 'user-1',
              name: 'Poster',
              formatName: 'Portrait',
              width: 900,
              height: 1200,
            }),
          },
        }),
      }),
    );
  });

  it('rejects duplicate field keys in the current version', async () => {
    const { prisma, service } = createService();
    prisma.templateField.findMany.mockResolvedValue([
      { id: 'field-1', key: 'headline', displayOrder: 0 },
    ]);
    await expect(
      service.addField(principal, draft.id, {
        key: 'headline',
        label: 'Headline',
        type: TemplateFieldType.TEXT,
      }),
    ).rejects.toThrow('Field key already exists');
    expect(prisma.templateField.create).not.toHaveBeenCalled();
  });

  it('rejects unsafe mapping keys and incompatible asset mapping types', async () => {
    const { service } = createService();
    await expect(
      service.addField(principal, draft.id, {
        key: 'title',
        label: 'Title',
        type: TemplateFieldType.TEXT,
        dataSource: TemplateDataSource.BRANCH,
        sourceKey: 'organizationId',
      }),
    ).rejects.toThrow('Unsupported template data mapping');
    await expect(
      service.addField(principal, draft.id, {
        key: 'logo',
        label: 'Logo',
        type: TemplateFieldType.TEXT,
        dataSource: TemplateDataSource.EFFECTIVE_BRAND,
        sourceKey: 'logoAssetId',
      }),
    ).rejects.toThrow('Image and logo fields');
  });

  it('prevents edits to a template after activation', async () => {
    const active = {
      ...draft,
      status: TemplateStatus.ACTIVE,
      activeVersionNumber: 1,
    };
    const { prisma, service } = createService({
      template: {
        findFirst: vi.fn().mockResolvedValue(active),
        update: vi.fn(),
      },
      templateVersion: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ...version, immutableAt: new Date() }),
      },
    });
    await expect(
      service.update(principal, active.id, { name: 'Changed' }),
    ).rejects.toThrow('create a new draft version');
    await expect(
      service.addField(principal, active.id, {
        key: 'title',
        label: 'Title',
        type: TemplateFieldType.TEXT,
      }),
    ).rejects.toThrow('create a new draft version');
    expect(prisma.template.update).not.toHaveBeenCalled();
    expect(prisma.templateField.create).not.toHaveBeenCalled();
  });

  it('rejects edits and new versions for archived templates', async () => {
    const archived = { ...draft, status: TemplateStatus.ARCHIVED };
    const { prisma, service } = createService({
      template: {
        findFirst: vi.fn().mockResolvedValue(archived),
        update: vi.fn(),
      },
    });
    await expect(
      service.update(principal, archived.id, { name: 'Changed' }),
    ).rejects.toThrow('Archived templates cannot be edited');
    await expect(service.createVersion(principal, archived.id)).rejects.toThrow(
      'Archived templates cannot be revised',
    );
    await expect(service.activate(principal, archived.id)).rejects.toThrow(
      'Archived templates cannot be edited',
    );
    expect(prisma.template.update).not.toHaveBeenCalled();
    expect(prisma.templateVersion.create).not.toHaveBeenCalled();
  });

  it('activates a valid draft and freezes its complete metadata snapshot', async () => {
    const { prisma, service } = createService({
      templateVersion: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ...version, fields: [{ id: 'field-1' }] }),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      template: {
        findFirst: vi.fn().mockResolvedValue(draft),
        findUniqueOrThrow: vi.fn().mockResolvedValue(draft),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    });
    await service.activate(principal, draft.id);
    expect(prisma.templateVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'version-1', immutableAt: null },
        data: expect.objectContaining({
          immutableAt: expect.any(Date),
          name: 'Social',
          formatName: 'Square',
          width: 1080,
          height: 1080,
          unit: 'PX',
        }),
      }),
    );
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: TemplateStatus.ACTIVE,
          activeVersionNumber: 1,
        }),
      }),
    );
  });

  it('creates the next draft from an immutable active snapshot', async () => {
    const active = {
      ...draft,
      status: TemplateStatus.ACTIVE,
      activeVersionNumber: 1,
    };
    const originalField = {
      id: 'old-field',
      versionId: 'version-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      key: 'headline',
      label: 'Headline',
      type: TemplateFieldType.TEXT,
      required: true,
      defaultValue: 'Spring',
      validationRules: null,
      helpText: null,
      displayOrder: 0,
      dataSource: null,
      sourceKey: null,
    };
    const transaction = {
      templateVersion: {
        create: vi.fn().mockResolvedValue({ versionNumber: 2 }),
      },
      template: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      template: {
        findFirst: vi.fn().mockResolvedValue(active),
        update: vi.fn(),
      },
      templateVersion: {
        findUnique: vi.fn().mockResolvedValue({
          ...version,
          immutableAt: new Date(),
          fields: [originalField],
        }),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const service = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      audit as never,
    );
    await service.createVersion(principal, active.id);
    expect(transaction.templateVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          versionNumber: 2,
          fields: {
            create: [
              expect.objectContaining({ key: 'headline', label: 'Headline' }),
            ],
          },
        }),
      }),
    );
    // The template stays ACTIVE on its frozen active version 1.
    expect(transaction.template.update).toHaveBeenCalledWith({
      where: { id: active.id },
      data: { currentVersionNumber: 2, updatedById: principal.id },
    });
    expect(audit.write).toHaveBeenCalledWith(transaction, {
      organizationId: principal.organizationId,
      actorUserId: principal.id,
      action: 'template.version_created',
      entityType: 'template',
      entityId: active.id,
      metadata: { versionNumber: 2, sourceVersionNumber: 1 },
    });
  });

  it('keeps the active version usable for new creatives while a newer draft exists', async () => {
    // Template state after createVersion: ACTIVE, active v1 frozen, v2 draft.
    const template = { status: TemplateStatus.ACTIVE, activeVersionNumber: 1 };
    const versions = {
      'version-1': {
        ...version,
        immutableAt: new Date(),
        template,
        fields: [
          {
            id: 'field-1',
            key: 'headline',
            label: 'Headline',
            type: TemplateFieldType.TEXT,
            required: false,
            defaultValue: null,
            validationRules: null,
          },
        ],
      },
      'version-2': {
        ...version,
        id: 'version-2',
        versionNumber: 2,
        immutableAt: null,
        template,
        fields: [],
      },
    };
    const findFirst = vi.fn(
      async ({
        where,
      }: {
        where: { id: keyof typeof versions; immutableAt: { not: null } };
      }) => {
        const candidate = versions[where.id];
        return where.immutableAt && !candidate.immutableAt ? null : candidate;
      },
    );
    const { service } = createService({ templateVersion: { findFirst } });
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-1', {
        headline: 'Live',
      }),
    ).resolves.toEqual({
      versionId: 'version-1',
      values: { headline: 'Live' },
    });
    await expect(
      service.validateCreativeValues(principal, 'branch-1', 'version-2', {}),
    ).rejects.toThrow('Template version not found');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'version-2',
          immutableAt: { not: null },
          template: { organizationId: principal.organizationId },
        },
      }),
    );
  });

  it('allows editing the draft version of an active template', async () => {
    const active = {
      ...draft,
      status: TemplateStatus.ACTIVE,
      currentVersionNumber: 2,
      activeVersionNumber: 1,
    };
    const draftVersion = {
      ...version,
      id: 'version-2',
      versionNumber: 2,
      fields: [],
    };
    const { prisma, service } = createService({
      template: {
        findFirst: vi.fn().mockResolvedValue(active),
        findUniqueOrThrow: vi.fn().mockResolvedValue(active),
      },
      templateVersion: { findUnique: vi.fn().mockResolvedValue(draftVersion) },
    });
    await service.addField(principal, active.id, {
      key: 'offer',
      label: 'Offer',
      type: TemplateFieldType.TEXT,
    });
    expect(prisma.templateVersion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          templateId_versionNumber: { templateId: active.id, versionNumber: 2 },
        },
      }),
    );
    expect(prisma.templateField.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: 'offer', versionId: 'version-2' }),
      }),
    );
  });

  it('activating the draft switches the active version and audits the change', async () => {
    const active = {
      ...draft,
      status: TemplateStatus.ACTIVE,
      currentVersionNumber: 2,
      activeVersionNumber: 1,
    };
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'version-2' }]),
      templateField: { count: vi.fn().mockResolvedValue(1) },
      templateVersion: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      template: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(active),
        update: vi.fn(),
      },
    };
    const prisma = {
      template: { findFirst: vi.fn().mockResolvedValue(active) },
      templateVersion: {
        findUnique: vi.fn().mockResolvedValue({
          ...version,
          id: 'version-2',
          versionNumber: 2,
          fields: [{ id: 'field-1' }],
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const service = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      audit as never,
    );
    await service.activate(principal, active.id);
    expect(transaction.templateVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'version-2', immutableAt: null },
        data: expect.objectContaining({ immutableAt: expect.any(Date) }),
      }),
    );
    expect(transaction.template.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: TemplateStatus.ACTIVE,
          activeVersionNumber: 2,
        }),
      }),
    );
    expect(audit.write).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        action: 'template.activated',
        entityId: active.id,
        metadata: { versionNumber: 2, previousActiveVersionNumber: 1 },
      }),
    );
  });

  it('rejects a second draft version while one is already in progress', async () => {
    const active = {
      ...draft,
      status: TemplateStatus.ACTIVE,
      currentVersionNumber: 2,
      activeVersionNumber: 1,
    };
    const { prisma, service } = createService({
      template: { findFirst: vi.fn().mockResolvedValue(active) },
    });
    await expect(service.createVersion(principal, active.id)).rejects.toThrow(
      'only be created from an activated version',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('enforces permissions and organization scope for version lifecycle actions', async () => {
    const reader = { ...principal, permissions: [PERMISSIONS.TEMPLATE_READ] };
    const editor = {
      ...principal,
      permissions: [PERMISSIONS.TEMPLATE_READ, PERMISSIONS.TEMPLATE_EDIT],
    };
    const { prisma, service } = createService();
    await expect(service.createVersion(reader, draft.id)).rejects.toThrow(
      'Permission denied',
    );
    await expect(service.activate(editor, draft.id)).rejects.toThrow(
      'Permission denied',
    );
    expect(prisma.template.findFirst).not.toHaveBeenCalled();
    prisma.template.findFirst.mockResolvedValue(null);
    await expect(
      service.createVersion(principal, 'foreign-template'),
    ).rejects.toThrow('Template not found');
    await expect(
      service.activate(principal, 'foreign-template'),
    ).rejects.toThrow('Template not found');
    expect(prisma.template.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-template',
        organizationId: principal.organizationId,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('archives a template only through the explicit archive action', async () => {
    const { prisma, service } = createService();
    prisma.template.update.mockResolvedValue({
      ...draft,
      status: TemplateStatus.ARCHIVED,
    });
    await service.archive(principal, draft.id);
    expect(prisma.template.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: TemplateStatus.ARCHIVED, updatedById: principal.id },
      }),
    );
  });

  it('rejects preview branch IDs outside the authenticated users branch scope', async () => {
    const branchUser = {
      ...principal,
      permissions: [PERMISSIONS.TEMPLATE_READ, PERMISSIONS.BRAND_READ],
    };
    const { prisma, service } = createService({
      userBranchAccess: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      service.preview(branchUser, draft.id, 'foreign-branch', {}),
    ).rejects.toThrow('Branch not found');
    expect(prisma.template.findFirst).not.toHaveBeenCalled();
  });

  it('returns only authorized asset metadata for a mapped logo preview', async () => {
    const activeVersion = {
      ...version,
      fields: [
        {
          id: 'logo-field',
          key: 'logo',
          label: 'Logo',
          type: TemplateFieldType.LOGO,
          required: false,
          defaultValue: null,
          validationRules: null,
          helpText: null,
          displayOrder: 0,
          dataSource: TemplateDataSource.EFFECTIVE_BRAND,
          sourceKey: 'logoAssetId',
        },
      ],
    };
    const prisma = {
      template: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ ...draft, activeVersionNumber: 1 }),
      },
      templateVersion: { findUnique: vi.fn().mockResolvedValue(activeVersion) },
      branch: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'branch-1',
          organizationId: 'org-1',
          status: 'ACTIVE',
        }),
      },
      asset: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const brand = {
      organization: vi.fn().mockResolvedValue({ logoAssetId: 'logo-asset' }),
      effective: vi.fn().mockResolvedValue({ logoAssetId: 'logo-asset' }),
    };
    const service = new TemplatesService(
      prisma as unknown as PrismaService,
      brand as unknown as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    const result = await service.preview(principal, draft.id, 'branch-1', {});
    expect(result.fields[0]?.value).toBeNull();
    expect(prisma.asset.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'logo-asset',
          organizationId: 'org-1',
          OR: [{ branchId: null }, { branchId: 'branch-1' }],
        }),
        select: { id: true, originalName: true, mimeType: true },
      }),
    );
  });

  it('reports invalid explicitly supplied custom preview values', async () => {
    const customVersion = {
      ...version,
      fields: [
        {
          id: 'color-field',
          key: 'accent',
          label: 'Accent',
          type: TemplateFieldType.COLOR,
          required: true,
          defaultValue: null,
          validationRules: null,
          helpText: null,
          displayOrder: 0,
          dataSource: TemplateDataSource.CUSTOM,
          sourceKey: null,
        },
      ],
    };
    const prisma = {
      template: { findFirst: vi.fn().mockResolvedValue(draft) },
      templateVersion: { findUnique: vi.fn().mockResolvedValue(customVersion) },
      branch: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'branch-1',
          organizationId: 'org-1',
          status: 'ACTIVE',
        }),
      },
    };
    const service = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      { write: vi.fn().mockResolvedValue({}) } as never,
    );
    const result = await service.preview(principal, draft.id, 'branch-1', {
      accent: 'red',
    });
    expect(result.fields[0]).toMatchObject({
      value: 'red',
      validationError: 'Enter a six-digit hex color',
    });
  });
});

function uniqueViolation(target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('TemplatesService concurrent unique conflicts', () => {
  function createVersionService(failure: unknown) {
    const active = {
      ...draft,
      status: TemplateStatus.ACTIVE,
      activeVersionNumber: 1,
    };
    const transaction = {
      templateVersion: { create: vi.fn().mockRejectedValue(failure) },
      template: { update: vi.fn() },
    };
    const prisma = {
      template: { findFirst: vi.fn().mockResolvedValue(active) },
      templateVersion: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ...version, immutableAt: new Date() }),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const audit = { write: vi.fn().mockResolvedValue({}) };
    const service = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      audit as never,
    );
    return { service, transaction, audit, active };
  }

  it('maps a concurrent version-number conflict to 409 without auditing', async () => {
    const { service, transaction, audit, active } = createVersionService(
      uniqueViolation(['templateId', 'versionNumber']),
    );
    await expect(
      service.createVersion(principal, active.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.template.update).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('recognizes the version-number conflict when Prisma reports the constraint name', async () => {
    const { service, active } = createVersionService(
      uniqueViolation('template_versions_templateId_versionNumber_key'),
    );
    await expect(
      service.createVersion(principal, active.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rethrows an unrelated unique-constraint error from draft version creation', async () => {
    const unrelated = uniqueViolation(['versionId', 'key']);
    const { service, active } = createVersionService(unrelated);
    await expect(service.createVersion(principal, active.id)).rejects.toBe(
      unrelated,
    );
  });

  it('rethrows other database errors from draft version creation unchanged', async () => {
    const foreignKey = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed',
      { code: 'P2003', clientVersion: 'test' },
    );
    const { service, active } = createVersionService(foreignKey);
    await expect(service.createVersion(principal, active.id)).rejects.toBe(
      foreignKey,
    );
    const lost = new Error('connection lost');
    const second = createVersionService(lost);
    await expect(
      second.service.createVersion(principal, second.active.id),
    ).rejects.toBe(lost);
  });

  it('maps a concurrent duplicate code on create to 409', async () => {
    const { service, prisma } = createService();
    prisma.template.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValueOnce(
      uniqueViolation(['organizationId', 'code']),
    );
    await expect(
      service.create(principal, {
        name: 'Social',
        code: 'social',
        formatName: 'Square',
        width: 1080,
        height: 1080,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('rethrows an unrelated unique-constraint error on create', async () => {
    const { service, prisma } = createService();
    const unrelated = uniqueViolation(['templateId', 'versionNumber']);
    prisma.template.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValueOnce(unrelated);
    await expect(
      service.create(principal, {
        name: 'Social',
        code: 'social',
        formatName: 'Square',
        width: 1080,
        height: 1080,
      }),
    ).rejects.toBe(unrelated);
  });

  it('maps a concurrent duplicate code on update to 409', async () => {
    const { service, prisma } = createService();
    // First lookup loads the template; the duplicate-code pre-check passes.
    prisma.template.findFirst
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(null);
    prisma.$transaction.mockRejectedValueOnce(
      uniqueViolation('templates_organizationId_code_key'),
    );
    await expect(
      service.update(principal, draft.id, { code: 'taken' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('rethrows other database errors on update unchanged', async () => {
    const { service, prisma } = createService();
    const lost = new Error('connection lost');
    prisma.$transaction.mockRejectedValueOnce(lost);
    await expect(
      service.update(principal, draft.id, { name: 'Renamed' }),
    ).rejects.toBe(lost);
  });
});

describe('TemplatesService draft-version locking', () => {
  const textField = (overrides: Record<string, unknown> = {}) => ({
    id: 'field-1',
    versionId: 'version-1',
    key: 'headline',
    label: 'Headline',
    type: TemplateFieldType.TEXT,
    required: false,
    defaultValue: null,
    validationRules: null,
    helpText: null,
    displayOrder: 0,
    dataSource: null,
    sourceKey: null,
    ...overrides,
  });

  // `snapshot` and `precheck` are what editable() loads before the
  // transaction; `fresh` and `current` are the fields and template row the
  // transaction reads after taking the locks.
  function lockingService(
    options: {
      locked?: boolean;
      snapshot?: unknown[];
      fresh?: unknown[];
      precheck?: Record<string, unknown>;
      current?: Record<string, unknown>;
      fieldCount?: number;
      // Rows the conditional freeze reports as changed.
      frozenCount?: number;
      writeError?: unknown;
      auditError?: unknown;
      // Use the real AuditService so its metadata validation runs.
      realAudit?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const freshFields = (options.fresh ?? []) as Array<Record<string, unknown>>;
    const step = (name: string, result?: (args: never) => unknown) =>
      vi.fn(async (args: never) => {
        calls.push(name);
        if (options.writeError && name.startsWith('field.'))
          throw options.writeError;
        return result?.(args);
      });
    const transaction = {
      $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
        if (sql.join('?').includes('"templates"')) {
          calls.push('lock.template');
          return [{ id: draft.id }];
        }
        calls.push('lock.version');
        return options.locked === false ? [] : [{ id: 'version-1' }];
      }),
      templateField: {
        findMany: step('fields.read', () => options.fresh ?? []),
        count: step('fields.count', () => options.fieldCount ?? 1),
        create: step('field.create', ({ data }: { data: object }) => ({
          id: 'field-new',
          ...data,
        })),
        update: step(
          'field.update',
          ({ where, data }: { where: { id: string }; data: object }) => ({
            ...freshFields.find((field) => field.id === where.id),
            ...data,
          }),
        ),
        delete: step('field.delete'),
      },
      auditLog: { create: step('audit') },
      templateVersion: {
        updateMany: step('version.freeze', () => ({
          count: options.frozenCount ?? 1,
        })),
      },
      template: {
        findUniqueOrThrow: step('template.read', () => ({
          ...draft,
          ...options.current,
        })),
        update: step('template.update'),
      },
    };
    const prisma = {
      template: {
        findFirst: vi.fn().mockResolvedValue({ ...draft, ...options.precheck }),
      },
      templateVersion: {
        findUnique: vi.fn().mockResolvedValue({
          ...version,
          fields: options.snapshot ?? [textField()],
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $transaction: vi.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>) =>
          callback(transaction),
      ),
    };
    const audit = options.realAudit
      ? { write: vi.fn(new AuditService({} as PrismaService).write) }
      : {
          write: vi.fn(async () => {
            calls.push('audit');
            if (options.auditError) throw options.auditError;
          }),
        };
    const service = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as BrandService,
      { assertCreativeAsset: vi.fn() } as unknown as AssetsService,
      audit as never,
    );
    return { service, transaction, calls, audit };
  }

  // Every successful path takes the version lock, then the template lock,
  // then re-reads the template row.
  const lockedTemplate = ['lock.version', 'lock.template', 'template.read'];

  const addOffer = (service: TemplatesService) =>
    service.addField(principal, draft.id, {
      key: 'offer',
      label: 'Offer',
      type: TemplateFieldType.TEXT,
    });

  it('locks the draft version row before activating it', async () => {
    const { service, transaction, calls } = lockingService();
    await service.activate(principal, draft.id);
    expect(calls).toEqual([
      ...lockedTemplate,
      'fields.count',
      'version.freeze',
      'template.update',
      'audit',
    ]);
    const [sql, versionId] = transaction.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(sql.join('?')).toMatch(/"immutableAt" IS NULL\s+FOR UPDATE/);
    expect(versionId).toBe('version-1');
  });

  it('rejects a competing activation without snapshot, template, or audit writes', async () => {
    const { service, calls } = lockingService({ locked: false });
    await expect(service.activate(principal, draft.id)).rejects.toThrow(
      new ConflictException('This template version has already been activated'),
    );
    expect(calls).toEqual(['lock.version']);
  });

  it('rejects activation when no fields remain inside the transaction', async () => {
    const { service, calls } = lockingService({ fieldCount: 0 });
    await expect(service.activate(principal, draft.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(calls).toEqual([...lockedTemplate, 'fields.count']);
  });

  it('freezes only a version that is still a draft', async () => {
    const { service, transaction } = lockingService();
    await service.activate(principal, draft.id);
    expect(transaction.templateVersion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'version-1', immutableAt: null },
      }),
    );
  });

  it('rejects activation without template or audit writes when the conditional freeze changes no row', async () => {
    const { service, calls, audit } = lockingService({ frozenCount: 0 });
    await expect(service.activate(principal, draft.id)).rejects.toThrow(
      new ConflictException('This template version has already been activated'),
    );
    expect(calls).toEqual([
      ...lockedTemplate,
      'fields.count',
      'version.freeze',
    ]);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it.each([
    ['add', addOffer],
    [
      'update',
      (service: TemplatesService) =>
        service.updateField(principal, draft.id, 'field-1', { label: 'New' }),
    ],
    [
      'remove',
      (service: TemplatesService) =>
        service.removeField(principal, draft.id, 'field-1'),
    ],
  ])(
    'rejects %s on a version frozen after the pre-check without writing fields',
    async (_action, mutate) => {
      const { service, calls } = lockingService({ locked: false });
      await expect(mutate(service)).rejects.toThrow(
        new ConflictException(
          'The current template version is immutable; create a new draft version to edit it',
        ),
      );
      expect(calls).toEqual(['lock.version']);
    },
  );

  it('validates a new field key and order against fields read after the lock', async () => {
    const duplicateKey = lockingService({ snapshot: [], fresh: [textField()] });
    await expect(
      duplicateKey.service.addField(principal, draft.id, {
        key: 'headline',
        label: 'Headline',
        type: TemplateFieldType.TEXT,
      }),
    ).rejects.toThrow('Field key already exists');
    expect(duplicateKey.calls).toEqual([...lockedTemplate, 'fields.read']);

    const duplicateOrder = lockingService({
      snapshot: [],
      fresh: [textField()],
    });
    await expect(
      duplicateOrder.service.addField(principal, draft.id, {
        key: 'offer',
        label: 'Offer',
        type: TemplateFieldType.TEXT,
        displayOrder: 0,
      }),
    ).rejects.toThrow('Field display order is already in use');
    expect(duplicateOrder.calls).toEqual([...lockedTemplate, 'fields.read']);
  });

  it('derives the default display order from fields read after the lock', async () => {
    const { service, transaction, calls } = lockingService({
      snapshot: [],
      fresh: [textField({ displayOrder: 4 })],
    });
    await addOffer(service);
    expect(calls).toEqual([
      ...lockedTemplate,
      'fields.read',
      'field.create',
      'audit',
    ]);
    expect(transaction.templateField.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: 'offer', displayOrder: 5 }),
    });
  });

  it('updates and removes fields found in the fresh read, not the stale snapshot', async () => {
    const renamed = lockingService({
      snapshot: [],
      fresh: [
        textField(),
        textField({ id: 'field-2', key: 'offer', displayOrder: 1 }),
      ],
    });
    await expect(
      renamed.service.updateField(principal, draft.id, 'field-2', {
        key: 'headline',
      }),
    ).rejects.toThrow('Field key already exists');
    expect(renamed.calls).toEqual([...lockedTemplate, 'fields.read']);

    const updated = lockingService({ snapshot: [], fresh: [textField()] });
    await updated.service.updateField(principal, draft.id, 'field-1', {
      label: 'Main headline',
    });
    expect(updated.calls).toEqual([
      ...lockedTemplate,
      'fields.read',
      'field.update',
      'audit',
    ]);

    const missing = lockingService({ snapshot: [textField()], fresh: [] });
    await expect(
      missing.service.removeField(principal, draft.id, 'field-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.calls).toEqual([...lockedTemplate, 'fields.read']);
  });

  it.each([
    ['add', addOffer],
    [
      'update',
      (service: TemplatesService) =>
        service.updateField(principal, draft.id, 'field-1', { key: 'offer' }),
    ],
  ])(
    'maps a field-key unique conflict on %s to 409',
    async (_action, mutate) => {
      const { service } = lockingService({
        fresh: [textField()],
        writeError: uniqueViolation(['versionId', 'key']),
      });
      await expect(mutate(service)).rejects.toThrow(
        new ConflictException('Field key already exists in this version'),
      );
    },
  );

  it('rethrows unrelated unique conflicts and other errors from field writes unchanged', async () => {
    for (const failure of [
      uniqueViolation(['templateId', 'versionNumber']),
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: 'test' },
      ),
      new Error('connection lost'),
    ]) {
      const { service } = lockingService({ writeError: failure });
      await expect(addOffer(service)).rejects.toBe(failure);
    }
  });

  it('locks the template row after the version row with a parameterized FOR NO KEY UPDATE', async () => {
    const { service, transaction } = lockingService();
    await service.activate(principal, draft.id);
    const [versionLock, templateLock] = transaction.$queryRaw.mock
      .calls as unknown as Array<[TemplateStringsArray, string]>;
    expect(versionLock[0].join('?')).toContain('"template_versions"');
    expect(templateLock[0].join('?')).toMatch(
      /FROM "templates"\s+WHERE "id" = \?\s+FOR NO KEY UPDATE/,
    );
    expect(templateLock[1]).toBe(draft.id);
  });

  it('does not unarchive a template archived after the activation pre-check', async () => {
    const { service, calls } = lockingService({
      current: { status: TemplateStatus.ARCHIVED },
    });
    await expect(service.activate(principal, draft.id)).rejects.toThrow(
      new ConflictException('Archived templates cannot be edited'),
    );
    expect(calls).toEqual(lockedTemplate);
  });

  it('freezes metadata committed after the activation pre-check, not the stale read', async () => {
    const { service, transaction, calls } = lockingService({
      precheck: { name: 'Social', width: 1080, activeVersionNumber: null },
      current: {
        name: 'Social v2',
        description: 'Updated',
        width: 1200,
        activeVersionNumber: 3,
      },
    });
    await service.activate(principal, draft.id);
    expect(transaction.templateVersion.updateMany).toHaveBeenCalledWith({
      where: { id: 'version-1', immutableAt: null },
      data: expect.objectContaining({
        immutableAt: expect.any(Date),
        name: 'Social v2',
        description: 'Updated',
        width: 1200,
      }),
    });
    expect(calls).toContain('audit');
  });

  it('records the previous active version from the row read under the lock', async () => {
    const { service, audit } = lockingService({
      precheck: { activeVersionNumber: null },
      current: { activeVersionNumber: 3 },
    });
    await service.activate(principal, draft.id);
    expect(audit.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'template.activated',
        metadata: { versionNumber: 1, previousActiveVersionNumber: 3 },
      }),
    );
  });

  it('rejects activation when metadata read under the lock is invalid', async () => {
    const { service, calls } = lockingService({ current: { width: 60000 } });
    await expect(service.activate(principal, draft.id)).rejects.toThrow(
      new BadRequestException('Template format or metadata is invalid'),
    );
    expect(calls).toEqual(lockedTemplate);
  });

  it('rejects a metadata update when the draft was activated after the pre-check', async () => {
    const { service, calls } = lockingService({ locked: false });
    await expect(
      service.update(principal, draft.id, { name: 'Renamed' }),
    ).rejects.toThrow(
      new ConflictException(
        'The current template version is immutable; create a new draft version to edit it',
      ),
    );
    expect(calls).toEqual(['lock.version']);
  });

  it('rejects a metadata update when the template was archived after the pre-check', async () => {
    const { service, calls } = lockingService({
      current: { status: TemplateStatus.ARCHIVED },
    });
    await expect(
      service.update(principal, draft.id, { name: 'Renamed' }),
    ).rejects.toThrow(
      new ConflictException('Archived templates cannot be edited'),
    );
    expect(calls).toEqual(lockedTemplate);
  });

  it('re-checks update dimensions against the row read under the lock', async () => {
    // 40000 x 1080 passes the pre-check; 40000 x 3000 exceeds the area limit.
    const { service, calls } = lockingService({
      precheck: { height: 1080 },
      current: { height: 3000 },
    });
    await expect(
      service.update(principal, draft.id, { width: 40000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toEqual(lockedTemplate);
  });

  it('updates metadata and audits it after taking both locks', async () => {
    const { service, transaction, calls } = lockingService();
    await service.update(principal, draft.id, { name: 'Renamed' });
    expect(calls).toEqual([...lockedTemplate, 'template.update', 'audit']);
    expect(transaction.template.update).toHaveBeenCalledWith({
      where: { id: draft.id },
      data: { name: 'Renamed', updatedById: principal.id },
    });
  });

  it('rejects field changes when the template was archived after the pre-check', async () => {
    const { service, calls } = lockingService({
      current: { status: TemplateStatus.ARCHIVED },
    });
    await expect(addOffer(service)).rejects.toThrow(
      new ConflictException('Archived templates cannot be edited'),
    );
    expect(calls).toEqual(lockedTemplate);
  });

  it('rejects changes when the locked version is no longer the current version', async () => {
    const { service, calls } = lockingService({
      current: { currentVersionNumber: 2 },
    });
    await expect(addOffer(service)).rejects.toBeInstanceOf(ConflictException);
    expect(calls).toEqual(lockedTemplate);
  });

  describe('field audit events', () => {
    const snapshotOf = (field: ReturnType<typeof textField>) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      displayOrder: field.displayOrder,
      dataSource: field.dataSource,
      sourceKey: field.sourceKey,
    });

    it('audits an added field in the same transaction, after the write', async () => {
      const { service, transaction, audit, calls } = lockingService({
        fresh: [textField()],
      });
      await addOffer(service);
      expect(calls).toEqual([
        ...lockedTemplate,
        'fields.read',
        'field.create',
        'audit',
      ]);
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write).toHaveBeenCalledWith(transaction, {
        organizationId: principal.organizationId,
        actorUserId: principal.id,
        action: 'template.field_added',
        entityType: 'template',
        entityId: draft.id,
        metadata: {
          versionNumber: 1,
          fieldId: 'field-new',
          field: {
            key: 'offer',
            label: 'Offer',
            type: TemplateFieldType.TEXT,
            required: undefined,
            displayOrder: 1,
            dataSource: undefined,
            sourceKey: undefined,
          },
        },
      });
    });

    it('audits an updated field with changed attributes and before/after values', async () => {
      const existing = textField();
      const { service, transaction, audit } = lockingService({
        fresh: [existing],
      });
      await service.updateField(principal, draft.id, 'field-1', {
        label: 'Main headline',
        required: true,
      });
      expect(audit.write).toHaveBeenCalledWith(transaction, {
        organizationId: principal.organizationId,
        actorUserId: principal.id,
        action: 'template.field_updated',
        entityType: 'template',
        entityId: draft.id,
        metadata: {
          versionNumber: 1,
          fieldId: 'field-1',
          changedFields: ['label', 'required'],
          before: snapshotOf(existing),
          after: {
            ...snapshotOf(existing),
            label: 'Main headline',
            required: true,
          },
        },
      });
    });

    it('audits a removed field with its last attributes', async () => {
      const existing = textField({
        key: 'promo',
        label: 'Promo',
        displayOrder: 3,
      });
      const { service, transaction, audit, calls } = lockingService({
        fresh: [existing],
      });
      await service.removeField(principal, draft.id, 'field-1');
      expect(calls).toEqual([
        ...lockedTemplate,
        'fields.read',
        'field.delete',
        'audit',
      ]);
      expect(audit.write).toHaveBeenCalledWith(transaction, {
        organizationId: principal.organizationId,
        actorUserId: principal.id,
        action: 'template.field_removed',
        entityType: 'template',
        entityId: draft.id,
        metadata: {
          versionNumber: 1,
          fieldId: 'field-1',
          field: snapshotOf(existing),
        },
      });
    });

    it.each([
      ['a version frozen after the pre-check', { locked: false }, addOffer],
      ['a duplicate key', { fresh: [textField({ key: 'offer' })] }, addOffer],
      [
        'a field-key unique conflict on write',
        { writeError: uniqueViolation(['versionId', 'key']) },
        addOffer,
      ],
      [
        'a missing field',
        { fresh: [] },
        (service: TemplatesService) =>
          service.removeField(principal, draft.id, 'field-1'),
      ],
      [
        'an archived template',
        { current: { status: TemplateStatus.ARCHIVED } },
        (service: TemplatesService) =>
          service.updateField(principal, draft.id, 'field-1', { label: 'X' }),
      ],
    ])(
      'writes no audit event when the mutation fails due to %s',
      async (_case, options, mutate) => {
        const { service, audit } = lockingService(options);
        await expect(mutate(service)).rejects.toBeDefined();
        expect(audit.write).not.toHaveBeenCalled();
      },
    );

    it('fails the whole mutation when the audit write fails, so the transaction rolls back', async () => {
      const auditFailure = new Error('audit insert failed');
      const { service, transaction, calls } = lockingService({
        fresh: [textField()],
        auditError: auditFailure,
      });
      await expect(addOffer(service)).rejects.toBe(auditFailure);
      // The field write and the failing audit write ran in one transaction
      // callback, so the error aborts both.
      expect(calls).toEqual([
        ...lockedTemplate,
        'fields.read',
        'field.create',
        'audit',
      ]);
      expect(transaction.templateField.create).toHaveBeenCalledTimes(1);
    });

    it('produces metadata accepted by the real audit validation, without default values', async () => {
      const { service, transaction } = lockingService({
        fresh: [textField()],
        realAudit: true,
      });
      await service.addField(principal, draft.id, {
        key: 'offer',
        label: 'L'.repeat(120),
        type: TemplateFieldType.TEXT,
        helpText: 'H'.repeat(500),
        defaultValue: 'internal draft copy',
        validationRules: { maxLength: 200 },
      });
      expect(transaction.auditLog.create).toHaveBeenCalledTimes(1);
      const [{ data }] = transaction.auditLog.create.mock
        .calls[0] as unknown as [
        { data: { action: string; metadata: object } },
      ];
      expect(data.action).toBe('template.field_added');
      const serialized = JSON.stringify(data.metadata);
      expect(serialized).not.toContain('internal draft copy');
      expect(serialized).not.toContain('maxLength');
      expect(serialized).not.toContain('HHHH');
    });
  });
});

describe('TemplatesService transaction contention', () => {
  const contention = (code: 'P2034' | 'P2028') =>
    new Prisma.PrismaClientKnownRequestError(`${code} from the database`, {
      code,
      clientVersion: 'test',
    });

  // Each operation's pre-checks pass, then its transaction fails.
  const operations: Array<
    [
      string,
      (prisma: ReturnType<typeof createService>['prisma']) => void,
      (service: TemplatesService) => Promise<unknown>,
    ]
  > = [
    [
      'create',
      (prisma) => prisma.template.findFirst.mockResolvedValue(null),
      (service) =>
        service.create(principal, {
          name: 'Social',
          code: 'social',
          formatName: 'Square',
          width: 1080,
          height: 1080,
        }),
    ],
    [
      'update',
      () => undefined,
      (service) => service.update(principal, draft.id, { name: 'Renamed' }),
    ],
    [
      'createVersion',
      (prisma) =>
        prisma.templateVersion.findUnique.mockResolvedValue({
          ...version,
          immutableAt: new Date(),
          fields: [],
        }),
      (service) => service.createVersion(principal, draft.id),
    ],
    [
      'addField',
      () => undefined,
      (service) =>
        service.addField(principal, draft.id, {
          key: 'offer',
          label: 'Offer',
          type: TemplateFieldType.TEXT,
        }),
    ],
    [
      'activate',
      (prisma) =>
        prisma.templateVersion.findUnique.mockResolvedValue({
          ...version,
          fields: [{ id: 'field-1' }],
        }),
      (service) => service.activate(principal, draft.id),
    ],
    [
      'archive',
      () => undefined,
      (service) => service.archive(principal, draft.id),
    ],
  ];

  it.each(operations)(
    'maps P2034 from %s to 409: rolled back, safe to retry',
    async (_name, arrange, run) => {
      const { prisma, service } = createService();
      arrange(prisma);
      prisma.$transaction.mockRejectedValueOnce(contention('P2034'));
      await expect(run(service)).rejects.toThrow(
        new ConflictException(transactionConflictMessage),
      );
    },
  );

  it.each(operations)(
    'maps P2028 from %s to 503 without claiming an outcome',
    async (_name, arrange, run) => {
      const { prisma, service } = createService();
      arrange(prisma);
      prisma.$transaction.mockRejectedValueOnce(contention('P2028'));
      await expect(run(service)).rejects.toThrow(
        new ServiceUnavailableException(transactionUnconfirmedMessage),
      );
    },
  );

  // How Prisma reports a PostgreSQL abort inside the raw row-lock queries.
  const rawQueryFailure = (sqlState: string) =>
    new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: sqlState, message: `ERROR: ${sqlState}` },
    });

  it.each(
    operations.flatMap(
      ([name, arrange, run]) =>
        [
          [name, '40P01', arrange, run],
          [name, '40001', arrange, run],
        ] as const,
    ),
  )(
    'maps a raw-query rollback from %s (P2010, %s) to 409',
    async (_name, sqlState, arrange, run) => {
      const { prisma, service } = createService();
      arrange(prisma);
      prisma.$transaction.mockRejectedValueOnce(rawQueryFailure(sqlState));
      await expect(run(service)).rejects.toThrow(
        new ConflictException(transactionConflictMessage),
      );
    },
  );

  it('rethrows other raw-query failures unchanged', async () => {
    const undefinedTable = rawQueryFailure('42P01');
    const { prisma, service } = createService();
    prisma.templateVersion.findUnique.mockResolvedValue({
      ...version,
      fields: [{ id: 'field-1' }],
    });
    prisma.$transaction.mockRejectedValueOnce(undefinedTable);
    await expect(service.activate(principal, draft.id)).rejects.toBe(
      undefinedTable,
    );
  });

  it('does not retry the transaction automatically', async () => {
    const { prisma, service } = createService();
    prisma.$transaction.mockRejectedValueOnce(contention('P2034'));
    await expect(
      service.update(principal, draft.id, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('keeps unique-conflict mapping ahead of contention mapping', async () => {
    const { prisma, service } = createService();
    prisma.template.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValueOnce(
      uniqueViolation(['organizationId', 'code']),
    );
    await expect(
      service.create(principal, {
        name: 'Social',
        code: 'social',
        formatName: 'Square',
        width: 1080,
        height: 1080,
      }),
    ).rejects.toThrow(new ConflictException('Template code already exists'));
  });

  it('rethrows other Prisma and non-Prisma errors from archive unchanged', async () => {
    for (const failure of [
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test',
      }),
      new Error('connection lost'),
    ]) {
      const { prisma, service } = createService();
      prisma.$transaction.mockRejectedValueOnce(failure);
      await expect(service.archive(principal, draft.id)).rejects.toBe(failure);
    }
  });
});

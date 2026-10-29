import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TemplateDataSource,
  TemplateFieldType,
  TemplateStatus,
  TemplateUnit,
  type Template,
  type TemplateField,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { BrandService } from '../brand/brand.service';
import { AssetsService } from '../assets/assets.service';
import { PrismaService } from '../prisma/prisma.service';
import { transactionContentionException } from '../prisma/transaction-errors';
import { AuditService } from '../audit/audit.service';

const brandKeys = [
  'displayName',
  'primaryColor',
  'secondaryColor',
  'accentColor',
  'fontFamily',
  'websiteUrl',
  'logoAssetId',
] as const;
const branchKeys = [
  'name',
  'code',
  'address',
  'city',
  'state',
  'pincode',
  'phone',
  'whatsapp',
  'email',
  'googleMapsUrl',
] as const;
function jsonInput(
  value: unknown,
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
  if (value === undefined) return undefined;
  return value === null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

type UniqueConstraint = { name: string; fields: readonly string[] };
const templateCodeConstraint: UniqueConstraint = {
  name: 'templates_organizationId_code_key',
  fields: ['organizationId', 'code'],
};
const versionNumberConstraint: UniqueConstraint = {
  name: 'template_versions_templateId_versionNumber_key',
  fields: ['templateId', 'versionNumber'],
};
const fieldKeyConstraint: UniqueConstraint = {
  name: 'template_fields_versionId_key_key',
  fields: ['versionId', 'key'],
};
const immutableVersionMessage =
  'The current template version is immutable; create a new draft version to edit it';
const archivedTemplateMessage = 'Archived templates cannot be edited';
const alreadyActivatedMessage =
  'This template version has already been activated';

function exceedsFormatLimits(width: number, height: number): boolean {
  return width > 50000 || height > 50000 || width * height > 100000000;
}

// Field attributes recorded in audit metadata. Default values and validation
// rules are free-form and can be large, so they are omitted here; updates
// still name them in changedFields.
function fieldAuditSnapshot(field: TemplateField): Prisma.InputJsonObject {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    displayOrder: field.displayOrder,
    dataSource: field.dataSource,
    sourceKey: field.sourceKey,
  };
}

function hasInvalidActivationMetadata(template: Template): boolean {
  return (
    !template.name.trim() ||
    !template.code.trim() ||
    !template.formatName.trim() ||
    template.width < 1 ||
    template.height < 1 ||
    exceedsFormatLimits(template.width, template.height)
  );
}

// Only a P2002 whose target is exactly the given constraint counts; other
// unique violations and database errors must not be reported as conflicts.
function isUniqueConflict(
  error: unknown,
  constraint: UniqueConstraint,
): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  )
    return false;
  const target = error.meta?.target;
  if (typeof target === 'string') return target === constraint.name;
  return (
    Array.isArray(target) &&
    target.length === constraint.fields.length &&
    constraint.fields.every((field) => target.includes(field))
  );
}
type FieldInput = {
  key?: string;
  label?: string;
  type?: TemplateFieldType;
  required?: boolean;
  defaultValue?: unknown;
  validationRules?: Record<string, number> | null;
  helpText?: string | null;
  displayOrder?: number;
  dataSource?: TemplateDataSource | null;
  sourceKey?: string | null;
};

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brand: BrandService,
    private readonly assets: AssetsService,
    private readonly audit: AuditService,
  ) {}

  private require(user: AuthenticatedPrincipal, permission: string): void {
    if (!user.permissions.includes(permission))
      throw new ForbiddenException('Permission denied');
  }

  // For transactions with no other error mapping: translates contention
  // failures (P2034, P2028) and rethrows everything else unchanged.
  private async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (error: unknown) {
      throw transactionContentionException(error) ?? error;
    }
  }

  private async owned(user: AuthenticatedPrincipal, id: string) {
    const template = await this.prisma.template.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  // Editability follows the current version, not the template status: an
  // ACTIVE template keeps serving its frozen active version while a newer
  // unfrozen draft version is edited.
  private async editable(user: AuthenticatedPrincipal, id: string) {
    const template = await this.owned(user, id);
    if (template.status === TemplateStatus.ARCHIVED)
      throw new ConflictException(archivedTemplateMessage);
    const version = await this.prisma.templateVersion.findUnique({
      where: {
        templateId_versionNumber: {
          templateId: id,
          versionNumber: template.currentVersionNumber,
        },
      },
      include: { fields: { orderBy: { displayOrder: 'asc' } } },
    });
    if (!version || version.immutableAt)
      throw new ConflictException(immutableVersionMessage);
    return { template, version };
  }

  // editable() is a fast pre-check only. This takes the version row lock and
  // confirms the version is still a draft, so activation and field changes on
  // the same version run one at a time. A transaction waiting on the lock
  // re-evaluates "immutableAt" IS NULL once the holder commits.
  private async lockDraftVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    conflictMessage: string,
  ): Promise<void> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "template_versions"
      WHERE "id" = ${versionId} AND "immutableAt" IS NULL
      FOR UPDATE`;
    if (!locked.length) throw new ConflictException(conflictMessage);
  }

  // Lock order is always the draft version row, then the template row, so
  // these paths cannot deadlock with each other. archive() and
  // createVersion() update the template row, so they wait for this lock or
  // are seen by the re-read below. FOR NO KEY UPDATE still allows the
  // foreign-key share lock createVersion() takes when inserting a version.
  // The returned row is current as of the lock, so callers validate and
  // snapshot it instead of the pre-check read.
  private async lockEditableTemplate(
    tx: Prisma.TransactionClient,
    templateId: string,
    version: { id: string; versionNumber: number },
    versionConflictMessage: string,
  ): Promise<Template> {
    await this.lockDraftVersion(tx, version.id, versionConflictMessage);
    await tx.$queryRaw`
      SELECT "id" FROM "templates"
      WHERE "id" = ${templateId}
      FOR NO KEY UPDATE`;
    const template = await tx.template.findUniqueOrThrow({
      where: { id: templateId },
    });
    if (template.status === TemplateStatus.ARCHIVED)
      throw new ConflictException(archivedTemplateMessage);
    if (template.currentVersionNumber !== version.versionNumber)
      throw new ConflictException(immutableVersionMessage);
    return template;
  }

  // Field changes validate against fields read after the lock is held, not
  // the snapshot loaded by editable().
  private async mutateDraftFields<T>(
    templateId: string,
    version: { id: string; versionNumber: number },
    mutation: (
      tx: Prisma.TransactionClient,
      fields: TemplateField[],
    ) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockEditableTemplate(
          tx,
          templateId,
          version,
          immutableVersionMessage,
        );
        const fields = await tx.templateField.findMany({
          where: { versionId: version.id },
          orderBy: { displayOrder: 'asc' },
        });
        return mutation(tx, fields);
      });
    } catch (error: unknown) {
      if (isUniqueConflict(error, fieldKeyConstraint))
        throw new ConflictException('Field key already exists in this version');
      throw transactionContentionException(error) ?? error;
    }
  }

  private validateMapping(input: FieldInput): void {
    const source = input.dataSource;
    const key = input.sourceKey;
    if (!source) {
      if (key) throw new BadRequestException('sourceKey requires a dataSource');
      return;
    }
    if (source === TemplateDataSource.CUSTOM) {
      if (key)
        throw new BadRequestException(
          'Custom mappings use preview values and do not have a sourceKey',
        );
      return;
    }
    const keys: readonly string[] =
      source === TemplateDataSource.BRANCH ? branchKeys : brandKeys;
    if (!key || !keys.includes(key))
      throw new BadRequestException('Unsupported template data mapping');
    if (
      (input.type === TemplateFieldType.IMAGE ||
        input.type === TemplateFieldType.LOGO) !==
      (key === 'logoAssetId')
    )
      throw new BadRequestException(
        'Image and logo fields must map to a logo asset; other fields cannot map to assets',
      );
  }

  private validateField(input: FieldInput): void {
    if (!input.type) throw new BadRequestException('Field type is required');
    this.validateMapping(input);
    const value = input.defaultValue;
    if (value === undefined || value === null) return;
    if (
      input.type === TemplateFieldType.IMAGE ||
      input.type === TemplateFieldType.LOGO
    )
      throw new BadRequestException(
        'Asset fields cannot have a copied default value',
      );
    if (
      input.type === TemplateFieldType.NUMBER &&
      (typeof value !== 'number' || !Number.isFinite(value))
    )
      throw new BadRequestException('Number fields require a numeric default');
    if (input.type === TemplateFieldType.BOOLEAN && typeof value !== 'boolean')
      throw new BadRequestException('Boolean fields require a boolean default');
    if (
      typeof value !== 'string' &&
      input.type !== TemplateFieldType.NUMBER &&
      input.type !== TemplateFieldType.BOOLEAN
    )
      throw new BadRequestException('Field default has an invalid type');
    if (typeof value === 'string' && value.length > 10000)
      throw new BadRequestException('Field default is too long');
    const rules = input.validationRules;
    if (
      rules?.minLength !== undefined &&
      rules.maxLength !== undefined &&
      rules.minLength > rules.maxLength
    )
      throw new BadRequestException('minLength must not exceed maxLength');
    if (
      rules?.min !== undefined &&
      rules.max !== undefined &&
      rules.min > rules.max
    )
      throw new BadRequestException('min must not exceed max');
    if (
      rules &&
      input.type !== TemplateFieldType.NUMBER &&
      (rules.min !== undefined || rules.max !== undefined)
    )
      throw new BadRequestException(
        'Numeric validation rules are only allowed for number fields',
      );
    if (
      rules &&
      !(
        [
          TemplateFieldType.TEXT,
          TemplateFieldType.MULTILINE_TEXT,
          TemplateFieldType.PHONE,
          TemplateFieldType.URL,
          TemplateFieldType.DATE,
          TemplateFieldType.COLOR,
        ] as TemplateFieldType[]
      ).includes(input.type) &&
      (rules.minLength !== undefined || rules.maxLength !== undefined)
    )
      throw new BadRequestException(
        'Length validation rules are not supported for this field type',
      );
    if (
      typeof value === 'string' &&
      rules?.minLength !== undefined &&
      value.length < rules.minLength
    )
      throw new BadRequestException(
        'Field default is shorter than its minimum length',
      );
    if (
      typeof value === 'string' &&
      rules?.maxLength !== undefined &&
      value.length > rules.maxLength
    )
      throw new BadRequestException('Field default exceeds its maximum length');
    if (
      typeof value === 'number' &&
      rules?.min !== undefined &&
      value < rules.min
    )
      throw new BadRequestException('Field default is below its minimum');
    if (
      typeof value === 'number' &&
      rules?.max !== undefined &&
      value > rules.max
    )
      throw new BadRequestException('Field default exceeds its maximum');
    if (typeof value === 'string' && input.type === TemplateFieldType.URL) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:')
          throw new Error('Unsupported URL protocol');
      } catch {
        throw new BadRequestException('URL field default must be a valid URL');
      }
    }
    if (
      typeof value === 'string' &&
      input.type === TemplateFieldType.DATE &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    )
      throw new BadRequestException('Date field default must use YYYY-MM-DD');
    if (
      typeof value === 'string' &&
      input.type === TemplateFieldType.COLOR &&
      !/^#[0-9a-fA-F]{6}$/.test(value)
    )
      throw new BadRequestException(
        'Color field default must be a six-digit hex color',
      );
    if (
      typeof value === 'string' &&
      input.type === TemplateFieldType.PHONE &&
      !/^\+?[0-9 ()-]{7,24}$/.test(value)
    )
      throw new BadRequestException('Phone field default is invalid');
  }

  list(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.TEMPLATE_READ);
    return this.prisma.template
      .findMany({
        where: { organizationId: user.organizationId },
        orderBy: [{ updatedAt: 'desc' }],
      })
      .then(async (templates) =>
        Promise.all(
          templates.map(async (template) => ({
            ...template,
            currentVersion: await this.prisma.templateVersion.findUnique({
              where: {
                templateId_versionNumber: {
                  templateId: template.id,
                  versionNumber: template.currentVersionNumber,
                },
              },
              include: { fields: { orderBy: { displayOrder: 'asc' } } },
            }),
          })),
        ),
      );
  }

  async get(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.TEMPLATE_READ);
    const template = await this.owned(user, id);
    return {
      ...template,
      versions: await this.prisma.templateVersion.findMany({
        where: { templateId: id },
        orderBy: { versionNumber: 'desc' },
        include: { fields: { orderBy: { displayOrder: 'asc' } } },
      }),
    };
  }

  async create(
    user: AuthenticatedPrincipal,
    input: {
      name: string;
      code: string;
      description?: string | null;
      category?: string | null;
      formatName: string;
      width: number;
      height: number;
      unit?: TemplateUnit;
    },
  ) {
    this.require(user, PERMISSIONS.TEMPLATE_CREATE);
    if (
      input.width > 50000 ||
      input.height > 50000 ||
      input.width * input.height > 100000000
    )
      throw new BadRequestException(
        'Format dimensions exceed supported limits',
      );
    if (
      await this.prisma.template.findFirst({
        where: { organizationId: user.organizationId, code: input.code },
      })
    )
      throw new ConflictException('Template code already exists');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const template = await tx.template.create({
          data: {
            ...input,
            unit: input.unit,
            organizationId: user.organizationId,
            createdById: user.id,
            updatedById: user.id,
            versions: {
              create: {
                versionNumber: 1,
                createdById: user.id,
                name: input.name,
                description: input.description,
                category: input.category,
                formatName: input.formatName,
                width: input.width,
                height: input.height,
                unit: input.unit ?? TemplateUnit.PX,
              },
            },
          },
          include: { versions: { include: { fields: true } } },
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'template.created',
          entityType: 'template',
          entityId: template.id,
          metadata: { code: template.code },
        });
        return template;
      });
    } catch (error: unknown) {
      // A concurrent request claimed the code after the check above.
      if (isUniqueConflict(error, templateCodeConstraint))
        throw new ConflictException('Template code already exists');
      throw transactionContentionException(error) ?? error;
    }
  }

  async update(
    user: AuthenticatedPrincipal,
    id: string,
    input: Record<string, unknown>,
  ) {
    this.require(user, PERMISSIONS.TEMPLATE_EDIT);
    const { template, version } = await this.editable(user, id);
    const exceedsLimits = (current: Template) =>
      exceedsFormatLimits(
        (input.width as number | undefined) ?? current.width,
        (input.height as number | undefined) ?? current.height,
      );
    if (exceedsLimits(template))
      throw new BadRequestException(
        'Format dimensions exceed supported limits',
      );
    if (
      typeof input.code === 'string' &&
      input.code !== template.code &&
      (await this.prisma.template.findFirst({
        where: {
          organizationId: user.organizationId,
          code: input.code,
          id: { not: id },
        },
      }))
    )
      throw new ConflictException('Template code already exists');
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Rejects the update if the draft was activated or the template was
        // archived after the pre-check, and re-checks dimensions against the
        // current row.
        const current = await this.lockEditableTemplate(
          tx,
          id,
          version,
          immutableVersionMessage,
        );
        if (exceedsLimits(current))
          throw new BadRequestException(
            'Format dimensions exceed supported limits',
          );
        const template = await tx.template.update({
          where: { id },
          data: { ...input, updatedById: user.id },
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'template.updated',
          entityType: 'template',
          entityId: id,
          metadata: { fields: Object.keys(input) },
        });
        return template;
      });
    } catch (error: unknown) {
      // A concurrent request claimed the code after the check above.
      if (isUniqueConflict(error, templateCodeConstraint))
        throw new ConflictException('Template code already exists');
      throw transactionContentionException(error) ?? error;
    }
  }

  async createVersion(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.TEMPLATE_EDIT);
    const template = await this.owned(user, id);
    if (template.status === TemplateStatus.ARCHIVED)
      throw new ConflictException('Archived templates cannot be revised');
    const old = await this.prisma.templateVersion.findUnique({
      where: {
        templateId_versionNumber: {
          templateId: id,
          versionNumber: template.currentVersionNumber,
        },
      },
      include: { fields: true },
    });
    if (!old || !old.immutableAt)
      throw new ConflictException(
        'A new version can only be created from an activated version',
      );
    const next = template.currentVersionNumber + 1;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const version = await tx.templateVersion.create({
          data: {
            templateId: id,
            versionNumber: next,
            createdById: user.id,
            name: old.name,
            description: old.description,
            category: old.category,
            formatName: old.formatName,
            width: old.width,
            height: old.height,
            unit: old.unit,
            fields: {
              create: old.fields.map((field) => ({
                key: field.key,
                label: field.label,
                type: field.type,
                required: field.required,
                defaultValue: jsonInput(field.defaultValue),
                validationRules: jsonInput(field.validationRules),
                helpText: field.helpText,
                displayOrder: field.displayOrder,
                dataSource: field.dataSource,
                sourceKey: field.sourceKey,
              })),
            },
          },
          include: { fields: { orderBy: { displayOrder: 'asc' } } },
        });
        // Status and activeVersionNumber are left unchanged so the frozen
        // active version stays usable until the new draft is activated.
        await tx.template.update({
          where: { id },
          data: {
            currentVersionNumber: next,
            updatedById: user.id,
          },
        });
        await this.audit.write(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'template.version_created',
          entityType: 'template',
          entityId: id,
          metadata: {
            versionNumber: next,
            sourceVersionNumber: old.versionNumber,
          },
        });
        return version;
      });
    } catch (error: unknown) {
      // A concurrent request created this version number first; the whole
      // transaction, including its audit event, was rolled back.
      if (isUniqueConflict(error, versionNumberConstraint))
        throw new ConflictException(
          'A new draft version was created concurrently; reload the template',
        );
      throw transactionContentionException(error) ?? error;
    }
  }

  async addField(user: AuthenticatedPrincipal, id: string, input: FieldInput) {
    this.require(user, PERMISSIONS.TEMPLATE_EDIT);
    const { version } = await this.editable(user, id);
    this.validateField(input);
    return this.mutateDraftFields(id, version, async (tx, fields) => {
      if (fields.some((field) => field.key === input.key))
        throw new ConflictException('Field key already exists in this version');
      const displayOrder =
        input.displayOrder ??
        Math.max(-1, ...fields.map((field) => field.displayOrder)) + 1;
      if (fields.some((field) => field.displayOrder === displayOrder))
        throw new ConflictException('Field display order is already in use');
      const field = await tx.templateField.create({
        data: {
          key: input.key!,
          label: input.label!,
          type: input.type!,
          required: input.required,
          defaultValue: jsonInput(input.defaultValue),
          validationRules: jsonInput(input.validationRules),
          helpText: input.helpText,
          displayOrder,
          dataSource: input.dataSource,
          sourceKey: input.sourceKey,
          versionId: version.id,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'template.field_added',
        entityType: 'template',
        entityId: id,
        metadata: {
          versionNumber: version.versionNumber,
          fieldId: field.id,
          field: fieldAuditSnapshot(field),
        },
      });
      return field;
    });
  }

  async updateField(
    user: AuthenticatedPrincipal,
    id: string,
    fieldId: string,
    input: FieldInput,
  ) {
    this.require(user, PERMISSIONS.TEMPLATE_EDIT);
    const { version } = await this.editable(user, id);
    return this.mutateDraftFields(id, version, async (tx, fields) => {
      const field = fields.find((candidate) => candidate.id === fieldId);
      if (!field) throw new NotFoundException('Template field not found');
      const merged = { ...field, ...input } as FieldInput;
      this.validateField(merged);
      if (
        input.key &&
        input.key !== field.key &&
        fields.some((candidate) => candidate.key === input.key)
      )
        throw new ConflictException('Field key already exists in this version');
      if (
        input.displayOrder !== undefined &&
        fields.some(
          (candidate) =>
            candidate.id !== fieldId &&
            candidate.displayOrder === input.displayOrder,
        )
      )
        throw new ConflictException('Field display order is already in use');
      const updated = await tx.templateField.update({
        where: { id: fieldId },
        data: {
          ...input,
          defaultValue: jsonInput(input.defaultValue),
          validationRules: jsonInput(input.validationRules),
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'template.field_updated',
        entityType: 'template',
        entityId: id,
        metadata: {
          versionNumber: version.versionNumber,
          fieldId,
          changedFields: Object.keys(input),
          before: fieldAuditSnapshot(field),
          after: fieldAuditSnapshot(updated),
        },
      });
      return updated;
    });
  }

  async removeField(user: AuthenticatedPrincipal, id: string, fieldId: string) {
    this.require(user, PERMISSIONS.TEMPLATE_EDIT);
    const { version } = await this.editable(user, id);
    await this.mutateDraftFields(id, version, async (tx, fields) => {
      const field = fields.find((candidate) => candidate.id === fieldId);
      if (!field) throw new NotFoundException('Template field not found');
      await tx.templateField.delete({ where: { id: fieldId } });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'template.field_removed',
        entityType: 'template',
        entityId: id,
        metadata: {
          versionNumber: version.versionNumber,
          fieldId,
          field: fieldAuditSnapshot(field),
        },
      });
    });
    return { id: fieldId, deleted: true };
  }

  async activate(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.TEMPLATE_ACTIVATE);
    const { template: precheck, version } = await this.editable(user, id);
    if (hasInvalidActivationMetadata(precheck))
      throw new BadRequestException('Template format or metadata is invalid');
    if (!version.fields.length)
      throw new BadRequestException(
        'A template needs at least one field before activation',
      );
    await this.transaction(async (tx) => {
      // A competing activation that committed first leaves no draft to lock,
      // so this one writes nothing: no snapshot, template, or audit change.
      // An archive that committed first is rejected instead of being undone.
      const template = await this.lockEditableTemplate(
        tx,
        id,
        version,
        alreadyActivatedMessage,
      );
      // The snapshot uses metadata read under the lock, so an update that
      // committed after the pre-check is frozen rather than lost.
      if (hasInvalidActivationMetadata(template))
        throw new BadRequestException('Template format or metadata is invalid');
      // Fields may have been removed after the pre-check above.
      const fieldCount = await tx.templateField.count({
        where: { versionId: version.id },
      });
      if (!fieldCount)
        throw new BadRequestException(
          'A template needs at least one field before activation',
        );
      // The row lock already excludes a competing freeze; the condition keeps
      // the freeze from overwriting one if that lock is ever bypassed.
      const frozen = await tx.templateVersion.updateMany({
        where: { id: version.id, immutableAt: null },
        data: {
          immutableAt: new Date(),
          name: template.name,
          description: template.description,
          category: template.category,
          formatName: template.formatName,
          width: template.width,
          height: template.height,
          unit: template.unit,
        },
      });
      if (frozen.count !== 1)
        throw new ConflictException(alreadyActivatedMessage);
      await tx.template.update({
        where: { id },
        data: {
          status: TemplateStatus.ACTIVE,
          activeVersionNumber: version.versionNumber,
          updatedById: user.id,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'template.activated',
        entityType: 'template',
        entityId: id,
        metadata: {
          versionNumber: version.versionNumber,
          previousActiveVersionNumber: template.activeVersionNumber,
        },
      });
    });
    return this.get(user, id);
  }

  async archive(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.TEMPLATE_ARCHIVE);
    await this.owned(user, id);
    return this.transaction(async (tx) => {
      const template = await tx.template.update({
        where: { id },
        data: { status: TemplateStatus.ARCHIVED, updatedById: user.id },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'template.archived',
        entityType: 'template',
        entityId: id,
        metadata: {},
      });
      return template;
    });
  }

  async validateCreativeValues(
    user: AuthenticatedPrincipal,
    branchId: string,
    templateVersionId: string,
    supplied: Record<string, unknown>,
    retainedVersionId?: string,
  ): Promise<{
    versionId: string;
    values: Record<string, Prisma.InputJsonValue>;
  }> {
    const version = await this.prisma.templateVersion.findFirst({
      where: {
        id: templateVersionId,
        immutableAt: { not: null },
        template: { organizationId: user.organizationId },
      },
      include: {
        template: true,
        fields: { orderBy: { displayOrder: 'asc' } },
      },
    });
    if (!version) throw new NotFoundException('Template version not found');
    if (
      templateVersionId !== retainedVersionId &&
      (version.template.status !== TemplateStatus.ACTIVE ||
        version.template.activeVersionNumber !== version.versionNumber)
    )
      throw new ConflictException(
        'New creative revisions require an active template version',
      );
    const keys = new Set(version.fields.map((field) => field.key));
    if (Object.keys(supplied).some((key) => !keys.has(key)))
      throw new BadRequestException(
        'Creative contains unknown template fields',
      );

    const values: Record<string, Prisma.InputJsonValue> = {};
    for (const field of version.fields) {
      const value = Object.hasOwn(supplied, field.key)
        ? supplied[field.key]
        : field.defaultValue;
      if (value === null || value === undefined) {
        if (field.required)
          throw new BadRequestException(`${field.label} is required`);
        continue;
      }
      if (
        field.required &&
        typeof value === 'string' &&
        value.trim().length === 0
      )
        throw new BadRequestException(`${field.label} is required`);
      const isAsset =
        field.type === TemplateFieldType.IMAGE ||
        field.type === TemplateFieldType.LOGO;
      if (isAsset) {
        if (typeof value !== 'string' || value.length > 128)
          throw new BadRequestException(
            `${field.label} must reference an image asset`,
          );
        await this.assets.assertCreativeAsset(user, value, branchId);
      } else if (field.type === TemplateFieldType.NUMBER) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new BadRequestException(`${field.label} must be a number`);
      } else if (field.type === TemplateFieldType.BOOLEAN) {
        if (typeof value !== 'boolean')
          throw new BadRequestException(`${field.label} must be true or false`);
      } else if (typeof value !== 'string' || value.length > 10000) {
        throw new BadRequestException(
          `${field.label} must be text of at most 10000 characters`,
        );
      }
      const rules = field.validationRules as {
        minLength?: number;
        maxLength?: number;
        min?: number;
        max?: number;
      } | null;
      if (typeof value === 'string') {
        if (rules?.minLength !== undefined && value.length < rules.minLength)
          throw new BadRequestException(
            `${field.label} is shorter than allowed`,
          );
        if (rules?.maxLength !== undefined && value.length > rules.maxLength)
          throw new BadRequestException(
            `${field.label} is longer than allowed`,
          );
        if (field.type === TemplateFieldType.URL) {
          try {
            const parsed = new URL(value);
            if (!['http:', 'https:'].includes(parsed.protocol))
              throw new Error();
          } catch {
            throw new BadRequestException(
              `${field.label} must be a valid HTTP or HTTPS URL`,
            );
          }
        }
        if (
          field.type === TemplateFieldType.PHONE &&
          !/^\+?[0-9 ()-]{7,24}$/.test(value)
        )
          throw new BadRequestException(
            `${field.label} must be a valid phone number`,
          );
        if (
          field.type === TemplateFieldType.COLOR &&
          !/^#[0-9a-fA-F]{6}$/.test(value)
        )
          throw new BadRequestException(
            `${field.label} must be a six-digit hex color`,
          );
        if (
          field.type === TemplateFieldType.DATE &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
            Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
            new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
        )
          throw new BadRequestException(`${field.label} must use YYYY-MM-DD`);
      }
      if (typeof value === 'number') {
        if (rules?.min !== undefined && value < rules.min)
          throw new BadRequestException(`${field.label} is below its minimum`);
        if (rules?.max !== undefined && value > rules.max)
          throw new BadRequestException(`${field.label} exceeds its maximum`);
      }
      values[field.key] = value as Prisma.InputJsonValue;
    }
    return { versionId: version.id, values };
  }

  async preview(
    user: AuthenticatedPrincipal,
    id: string,
    branchId: string,
    customValues: Record<string, string>,
  ) {
    this.require(user, PERMISSIONS.TEMPLATE_READ);
    if (!user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)) {
      const access = await this.prisma.userBranchAccess.findFirst({
        where: {
          userId: user.id,
          branchId,
          branch: { organizationId: user.organizationId, status: 'ACTIVE' },
        },
        select: { branchId: true },
      });
      if (!access) throw new NotFoundException('Branch not found');
    }
    const branch = await this.prisma.branch.findFirst({
      where: {
        id: branchId,
        organizationId: user.organizationId,
        status: 'ACTIVE',
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const template = await this.owned(user, id);
    // Non-archived templates preview their current version, which is the
    // draft being edited when one exists and otherwise the active version.
    const versionNumber =
      template.status === TemplateStatus.ARCHIVED
        ? (template.activeVersionNumber ?? template.currentVersionNumber)
        : template.currentVersionNumber;
    const version = await this.prisma.templateVersion.findUnique({
      where: { templateId_versionNumber: { templateId: id, versionNumber } },
      include: { fields: { orderBy: { displayOrder: 'asc' } } },
    });
    if (!version) throw new NotFoundException('Template version not found');
    const hasBrandMapping = version.fields.some(
      (field) =>
        field.dataSource === TemplateDataSource.ORGANIZATION_BRAND ||
        field.dataSource === TemplateDataSource.EFFECTIVE_BRAND,
    );
    if (hasBrandMapping && !user.permissions.includes(PERMISSIONS.BRAND_READ))
      throw new ForbiddenException(
        'Brand read permission is required to resolve mapped brand fields',
      );
    const [organizationBrand, effectiveBrand] = hasBrandMapping
      ? await Promise.all([
          this.brand.organization(user),
          this.brand.effective(user, branchId),
        ])
      : [null, null];
    const resolved = await Promise.all(
      version.fields.map(async (field) => {
        let value: unknown = field.defaultValue;
        let validationError: string | null = null;
        if (field.dataSource === TemplateDataSource.CUSTOM) {
          const supplied = customValues[field.key];
          if (supplied !== undefined) {
            if (typeof supplied !== 'string' || supplied.length > 10000) {
              validationError = 'Preview value is invalid or too long';
              value = null;
            } else if (field.type === TemplateFieldType.NUMBER) {
              const numeric = Number(supplied);
              if (!Number.isFinite(numeric)) {
                validationError = 'Enter a valid number';
                value = null;
              } else value = numeric;
            } else if (field.type === TemplateFieldType.BOOLEAN) {
              if (supplied !== 'true' && supplied !== 'false') {
                validationError = 'Enter true or false';
                value = null;
              } else value = supplied === 'true';
            } else value = supplied;
          }
          const rules = field.validationRules as {
            minLength?: number;
            maxLength?: number;
            min?: number;
            max?: number;
          } | null;
          if (typeof value === 'string') {
            if (
              rules?.minLength !== undefined &&
              value.length < rules.minLength
            )
              validationError = 'Value is shorter than its minimum length';
            if (
              rules?.maxLength !== undefined &&
              value.length > rules.maxLength
            )
              validationError = 'Value exceeds its maximum length';
            if (field.type === TemplateFieldType.URL) {
              try {
                const url = new URL(value);
                if (url.protocol !== 'https:' && url.protocol !== 'http:')
                  throw new Error('Unsupported protocol');
              } catch {
                validationError = 'Enter a valid HTTP or HTTPS URL';
              }
            }
            if (
              field.type === TemplateFieldType.COLOR &&
              !/^#[0-9a-fA-F]{6}$/.test(value)
            )
              validationError = 'Enter a six-digit hex color';
            if (
              field.type === TemplateFieldType.PHONE &&
              !/^\+?[0-9 ()-]{7,24}$/.test(value)
            )
              validationError = 'Enter a valid phone number';
            if (
              field.type === TemplateFieldType.DATE &&
              (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
                Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
                new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !==
                  value)
            )
              validationError = 'Enter a valid date using YYYY-MM-DD';
          }
          if (typeof value === 'number') {
            if (rules?.min !== undefined && value < rules.min)
              validationError = 'Value is below its minimum';
            if (rules?.max !== undefined && value > rules.max)
              validationError = 'Value exceeds its maximum';
          }
        }
        if (field.required && (value === null || value === undefined))
          validationError = validationError ?? 'A value is required';
        else if (
          field.dataSource === TemplateDataSource.BRANCH &&
          field.sourceKey
        )
          value = branch[field.sourceKey as keyof typeof branch] ?? null;
        else if (
          field.dataSource === TemplateDataSource.ORGANIZATION_BRAND &&
          field.sourceKey
        )
          value =
            organizationBrand?.[
              field.sourceKey as keyof typeof organizationBrand
            ] ?? null;
        else if (
          field.dataSource === TemplateDataSource.EFFECTIVE_BRAND &&
          field.sourceKey
        )
          value = effectiveBrand?.[field.sourceKey] ?? null;
        if (
          (field.type === TemplateFieldType.LOGO ||
            field.type === TemplateFieldType.IMAGE) &&
          typeof value === 'string'
        ) {
          const asset = await this.prisma.asset.findFirst({
            where: {
              id: value,
              organizationId: user.organizationId,
              status: 'ACTIVE',
              OR: [{ branchId: null }, { branchId }],
            },
            select: { id: true, originalName: true, mimeType: true },
          });
          value = asset
            ? {
                id: asset.id,
                originalName: asset.originalName,
                mimeType: asset.mimeType,
              }
            : null;
          if (!asset)
            validationError =
              validationError ?? 'Select an in-scope active asset';
        }
        return {
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required,
          value,
          validationError,
        };
      }),
    );
    return {
      templateId: id,
      branchId,
      versionNumber,
      format: {
        name: version.formatName,
        width: version.width,
        height: version.height,
        unit: version.unit,
      },
      fields: resolved,
    };
  }
}

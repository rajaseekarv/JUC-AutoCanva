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
  UseGuards,
} from '@nestjs/common';
import {
  TemplateDataSource,
  TemplateFieldType,
  TemplateUnit,
} from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { PERMISSIONS } from '../auth/permissions';
import { TemplatesService } from './templates.service';

const metadataSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    code: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    category: z.string().trim().max(80).nullable().optional(),
    formatName: z.string().trim().min(1).max(80).optional(),
    width: z.number().int().min(1).max(100000).optional(),
    height: z.number().int().min(1).max(100000).optional(),
    unit: z.nativeEnum(TemplateUnit).optional(),
  })
  .strict();

const createSchema = metadataSchema
  .extend({
    name: z.string().trim().min(1).max(120),
    code: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    formatName: z.string().trim().min(1).max(80),
    width: z.number().int().min(1).max(100000),
    height: z.number().int().min(1).max(100000),
  })
  .strict();

const rulesSchema = z
  .object({
    minLength: z.number().int().min(0).max(10000).optional(),
    maxLength: z.number().int().min(1).max(10000).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict()
  .nullable()
  .optional();

const fieldSchemaBase = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().trim().min(1).max(120),
    type: z.nativeEnum(TemplateFieldType),
    required: z.boolean().optional(),
    defaultValue: z.unknown().optional(),
    validationRules: rulesSchema,
    helpText: z.string().trim().max(500).nullable().optional(),
    displayOrder: z.number().int().min(0).max(10000).optional(),
    dataSource: z.nativeEnum(TemplateDataSource).nullable().optional(),
    sourceKey: z.string().trim().max(64).nullable().optional(),
  })
  .strict();
const fieldSchema = fieldSchemaBase.superRefine((field, ctx) => {
  const rules = field.validationRules;
  if (
    rules?.minLength !== undefined &&
    rules.maxLength !== undefined &&
    rules.minLength > rules.maxLength
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'minLength must not exceed maxLength',
    });
  if (
    rules?.min !== undefined &&
    rules.max !== undefined &&
    rules.min > rules.max
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'min must not exceed max',
    });
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new BadRequestException('Invalid template data');
  return result.data;
}

@Controller('templates')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TEMPLATE_READ)
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.templates.list(user);
  }

  @Get(':templateId')
  @RequirePermissions(PERMISSIONS.TEMPLATE_READ)
  get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
  ) {
    return this.templates.get(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TEMPLATE_CREATE)
  create(@CurrentUser() user: AuthenticatedPrincipal, @Body() body: unknown) {
    return this.templates.create(user, parse(createSchema, body));
  }

  @Patch(':templateId')
  @RequirePermissions(PERMISSIONS.TEMPLATE_EDIT)
  update(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
    @Body() body: unknown,
  ) {
    return this.templates.update(
      user,
      id,
      parse(
        metadataSchema.refine((data) => Object.keys(data).length > 0),
        body,
      ),
    );
  }

  @Post(':templateId/versions')
  @RequirePermissions(PERMISSIONS.TEMPLATE_EDIT)
  createVersion(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
  ) {
    return this.templates.createVersion(user, id);
  }

  @Post(':templateId/fields')
  @RequirePermissions(PERMISSIONS.TEMPLATE_EDIT)
  addField(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
    @Body() body: unknown,
  ) {
    return this.templates.addField(user, id, parse(fieldSchema, body));
  }

  @Patch(':templateId/fields/:fieldId')
  @RequirePermissions(PERMISSIONS.TEMPLATE_EDIT)
  updateField(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
    @Param('fieldId') fieldId: string,
    @Body() body: unknown,
  ) {
    return this.templates.updateField(
      user,
      id,
      fieldId,
      parse(
        fieldSchemaBase
          .partial()
          .refine((data) => Object.keys(data).length > 0),
        body,
      ),
    );
  }

  @Delete(':templateId/fields/:fieldId')
  @RequirePermissions(PERMISSIONS.TEMPLATE_EDIT)
  removeField(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
    @Param('fieldId') fieldId: string,
  ) {
    return this.templates.removeField(user, id, fieldId);
  }

  @Post(':templateId/activate')
  @RequirePermissions(PERMISSIONS.TEMPLATE_ACTIVATE)
  activate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
  ) {
    return this.templates.activate(user, id);
  }

  @Post(':templateId/archive')
  @RequirePermissions(PERMISSIONS.TEMPLATE_ARCHIVE)
  archive(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
  ) {
    return this.templates.archive(user, id);
  }

  @Get(':templateId/preview')
  @RequirePermissions(PERMISSIONS.TEMPLATE_READ)
  preview(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('templateId') id: string,
    @Query('branchId') branchId: string,
    @Query() query: Record<string, string>,
  ) {
    const customValues = Object.fromEntries(
      Object.entries(query)
        .filter(([key]) => key.startsWith('value.'))
        .map(([key, value]) => [key.slice(6), value]),
    );
    if (!branchId) throw new BadRequestException('branchId is required');
    return this.templates.preview(user, id, branchId, customValues);
  }
}

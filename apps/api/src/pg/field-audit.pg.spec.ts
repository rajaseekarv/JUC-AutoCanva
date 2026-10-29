import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { AuditService, type AuditInput } from '../audit/audit.service';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  transactionConflictMessage,
  transactionUnconfirmedMessage,
} from '../prisma/transaction-errors';

// Real-PostgreSQL checks for Sprint 15: template field audit events, their
// atomicity with the field change, and the P2034/P2028 contention mapping.
// Same isolation rules as concurrency.pg.spec.ts: the `pg` Vitest project
// only exists when ADFLOW_PG_TEST_URL is set, and this file refuses any
// database that is not the stamped 127.0.0.1:55432 *_test database.
const isolated = {
  url: process.env.ADFLOW_PG_TEST_URL ?? '',
  marker: process.env.ADFLOW_PG_TEST_MARKER ?? '',
  dataDirectory: process.env.ADFLOW_PG_TEST_DATA_DIR ?? '',
};

function assertIsolatedUrl(raw: string): void {
  if (!raw) throw new Error('Refusing to run: ADFLOW_PG_TEST_URL is not set');
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  const problems: string[] = [];
  if (!['postgresql:', 'postgres:'].includes(url.protocol))
    problems.push(`protocol ${url.protocol}`);
  if (url.hostname !== '127.0.0.1') problems.push(`host ${url.hostname}`);
  if (url.port !== '55432') problems.push(`port ${url.port || '(default)'}`);
  if (!database.endsWith('_test')) problems.push(`database ${database}`);
  if (problems.length)
    throw new Error(
      `Refusing to run: not the isolated test database (${problems.join(', ')})`,
    );
}

const normalizePath = (value: string) =>
  value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

async function assertIsolatedServer(client: PrismaClient): Promise<void> {
  if (!isolated.marker || !isolated.dataDirectory)
    throw new Error('Refusing to run: test marker or data directory not set');
  const [identity] = await client.$queryRaw<
    Array<{
      database: string;
      address: string;
      port: number;
      dataDirectory: string;
      comment: string | null;
    }>
  >`
    SELECT current_database() AS "database",
           host(inet_server_addr()) AS "address",
           inet_server_port() AS "port",
           current_setting('data_directory') AS "dataDirectory",
           shobj_description(oid, 'pg_database') AS "comment"
    FROM pg_database WHERE datname = current_database()`;
  const problems: string[] = [];
  if (!identity?.database.endsWith('_test'))
    problems.push(`database ${identity?.database}`);
  if (identity?.address !== '127.0.0.1')
    problems.push(`address ${identity?.address}`);
  if (identity?.port !== 55432) problems.push(`port ${identity?.port}`);
  if (
    normalizePath(identity?.dataDirectory ?? '') !==
    normalizePath(isolated.dataDirectory)
  )
    problems.push('data directory is not the isolated test cluster');
  if (identity?.comment !== `adflow-isolated-test:${isolated.marker}`)
    problems.push('test marker missing or different');
  if (problems.length)
    throw new Error(
      `Refusing to run: server identity check failed (${problems.join(', ')})`,
    );
}

// Real AuditService, except that it can be told to throw *after* its insert
// for one action, so PostgreSQL must roll back both the audit row and the
// field change made earlier in the same transaction.
class FailAfterInsertAuditService extends AuditService {
  failAction: string | null = null;

  override async write(tx: Prisma.TransactionClient, input: AuditInput) {
    const row = await super.write(tx, input);
    if (input.action === this.failAction)
      throw new Error('Simulated audit failure after insert');
    return row;
  }
}

const fieldAuditActions = [
  'template.field_added',
  'template.field_updated',
  'template.field_removed',
];

describe('Real PostgreSQL: template field audit and contention', () => {
  let observer: PrismaClient;
  let holder: PrismaClient;
  let prisma: PrismaService;
  let audit: FailAfterInsertAuditService;
  let app: INestApplication;
  let token = '';
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  let templateCount = 0;

  beforeAll(async () => {
    assertIsolatedUrl(isolated.url);
    observer = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(observer);
    holder = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(holder);
    const appUrl = new URL(isolated.url);
    appUrl.searchParams.set('connection_limit', '12');
    prisma = new PrismaService({ datasourceUrl: appUrl.toString() });
    await assertIsolatedServer(prisma);
    audit = new FailAfterInsertAuditService(prisma);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AuditService)
      .useValue(audit)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    // Fixtures are written only after every identity check has passed.
    const organization = await prisma.organization.create({
      data: { name: 'PG field audit org', code: `pg-audit-${runId}` },
    });
    const codes = Object.values(PERMISSIONS);
    await prisma.permission.createMany({
      data: codes.map((code) => ({ code })),
      skipDuplicates: true,
    });
    const permissions = await prisma.permission.findMany({
      where: { code: { in: codes } },
    });
    const role = await prisma.role.create({
      data: {
        organizationId: organization.id,
        name: `pg-audit-admin-${runId}`,
        permissions: {
          create: permissions.map((permission) => ({
            permissionId: permission.id,
          })),
        },
      },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: organization.id,
        name: 'PG audit admin',
        email: `pg-audit-${runId}@example.test`,
        roleAssignments: { create: { roleId: role.id } },
      },
    });
    const session = await prisma.authSession.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    token = await app
      .get(JwtService)
      .signAsync({ sub: user.id, sid: session.id });
  });

  afterAll(async () => {
    await app?.close();
    await holder?.$disconnect();
    await observer?.$disconnect();
  });

  function call(
    method: 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
  ) {
    const agent = request(app.getHttpServer());
    const pending = agent[method](`/api/v1${path}`).set(
      'Authorization',
      `Bearer ${token}`,
    );
    return body ? pending.send(body) : pending;
  }

  async function waitForBlocked(count: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [{ blocked }] = await observer.$queryRaw<
        Array<{ blocked: number }>
      >`
        SELECT count(*)::int AS "blocked" FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()`;
      if (blocked >= count) return;
      if (Date.now() > deadline)
        throw new Error(`Expected ${count} blocked backends, saw ${blocked}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function draftTemplate(fieldKeys: string[] = ['headline']) {
    templateCount += 1;
    const created = await call('post', '/templates', {
      name: `Audit template ${templateCount}`,
      code: `pg-audit-${runId}-${templateCount}`,
      formatName: 'Square',
      width: 1080,
      height: 1080,
    }).expect(201);
    const templateId = created.body.id as string;
    for (const key of fieldKeys)
      await call('post', `/templates/${templateId}/fields`, {
        key,
        label: key,
        type: 'TEXT',
      }).expect(201);
    const version = await prisma.templateVersion.findUniqueOrThrow({
      where: { templateId_versionNumber: { templateId, versionNumber: 1 } },
      include: { fields: { orderBy: { displayOrder: 'asc' } } },
    });
    return { templateId, version };
  }

  const auditRows = (templateId: string, action: string) =>
    prisma.auditLog.findMany({
      where: { entityId: templateId, action },
      orderBy: { createdAt: 'asc' },
    });
  const fieldAuditCount = (templateId: string) =>
    prisma.auditLog.count({
      where: { entityId: templateId, action: { in: fieldAuditActions } },
    });

  describe('field audit events', () => {
    it('writes one audit row per successful add, update, and remove', async () => {
      const { templateId } = await draftTemplate([]);
      const added = await call('post', `/templates/${templateId}/fields`, {
        key: 'offer',
        label: 'Offer',
        type: 'TEXT',
        defaultValue: 'internal draft copy',
      }).expect(201);
      const fieldId = added.body.id as string;
      await call('patch', `/templates/${templateId}/fields/${fieldId}`, {
        label: 'Main offer',
        required: true,
      }).expect(200);
      await call('delete', `/templates/${templateId}/fields/${fieldId}`).expect(
        200,
      );

      const [addedRow] = await auditRows(templateId, 'template.field_added');
      const [updatedRow] = await auditRows(
        templateId,
        'template.field_updated',
      );
      const [removedRow] = await auditRows(
        templateId,
        'template.field_removed',
      );
      expect(await fieldAuditCount(templateId)).toBe(3);
      expect(addedRow.metadata).toMatchObject({
        versionNumber: 1,
        fieldId,
        field: { key: 'offer', label: 'Offer', type: 'TEXT', displayOrder: 0 },
      });
      expect(JSON.stringify(addedRow.metadata)).not.toContain(
        'internal draft copy',
      );
      expect(updatedRow.metadata).toMatchObject({
        fieldId,
        changedFields: ['label', 'required'],
        before: { label: 'Offer', required: false },
        after: { label: 'Main offer', required: true },
      });
      expect(removedRow.metadata).toMatchObject({
        fieldId,
        field: { key: 'offer', label: 'Main offer', required: true },
      });
      expect(await prisma.templateField.count({ where: { id: fieldId } })).toBe(
        0,
      );
    });

    it('writes no success audit row when a field mutation is rejected', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const baseline = await fieldAuditCount(templateId);
      await call('post', `/templates/${templateId}/fields`, {
        key: 'headline',
        label: 'Duplicate',
        type: 'TEXT',
      }).expect(409);
      await call('patch', `/templates/${templateId}/fields/missing-field-id`, {
        label: 'Nope',
      }).expect(404);
      await call('post', `/templates/${templateId}/activate`).expect(201);
      await call('post', `/templates/${templateId}/fields`, {
        key: 'late',
        label: 'Late',
        type: 'TEXT',
      }).expect(409);
      await call(
        'delete',
        `/templates/${templateId}/fields/${version.fields[0].id}`,
      ).expect(409);
      expect(await fieldAuditCount(templateId)).toBe(baseline);
      expect(
        await prisma.templateField.count({ where: { versionId: version.id } }),
      ).toBe(1);
    });

    it('rolls back an added field when its audit write fails after inserting', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      audit.failAction = 'template.field_added';
      try {
        await call('post', `/templates/${templateId}/fields`, {
          key: 'rolled_back',
          label: 'Rolled back',
          type: 'TEXT',
        }).expect(500);
      } finally {
        audit.failAction = null;
      }
      expect(
        await prisma.templateField.count({
          where: { versionId: version.id, key: 'rolled_back' },
        }),
      ).toBe(0);
      expect(await auditRows(templateId, 'template.field_added')).toHaveLength(
        1, // only the fixture's 'headline' field
      );
    });

    it('rolls back a field update when its audit write fails after inserting', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const [field] = version.fields;
      audit.failAction = 'template.field_updated';
      try {
        await call('patch', `/templates/${templateId}/fields/${field.id}`, {
          label: 'Should not persist',
        }).expect(500);
      } finally {
        audit.failAction = null;
      }
      const persisted = await prisma.templateField.findUniqueOrThrow({
        where: { id: field.id },
      });
      expect(persisted.label).toBe('headline');
      expect(
        await auditRows(templateId, 'template.field_updated'),
      ).toHaveLength(0);
    });

    it('rolls back a field removal when its audit write fails after inserting', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const [field] = version.fields;
      audit.failAction = 'template.field_removed';
      try {
        await call(
          'delete',
          `/templates/${templateId}/fields/${field.id}`,
        ).expect(500);
      } finally {
        audit.failAction = null;
      }
      expect(
        await prisma.templateField.count({ where: { id: field.id } }),
      ).toBe(1);
      expect(
        await auditRows(templateId, 'template.field_removed'),
      ).toHaveLength(0);
    });
  });

  describe('transaction contention from real PostgreSQL', () => {
    // Inside $queryRaw, PostgreSQL's deadlock (40P01) reaches the service as
    // P2010 rather than P2034. This failed in Sprint 15.1 (HTTP 500); Sprint
    // 15.2 maps P2010 with 40P01/40001 to 409.
    it('maps a real PostgreSQL deadlock (40P01) to 409 and applies nothing', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      let templateLocked!: () => void;
      const lockedTemplate = new Promise<void>((resolve) => {
        templateLocked = resolve;
      });
      let activationBlocked!: () => void;
      const blockedActivation = new Promise<void>((resolve) => {
        activationBlocked = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The holder takes the template row, waits for the activation to block
      // on it while holding the version row, then requests the version row:
      // a lock cycle. Its raised deadlock_timeout makes PostgreSQL abort the
      // activation's transaction rather than the holder's.
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '10s'`);
          await tx.$queryRaw`SELECT "id" FROM "templates" WHERE "id" = ${templateId} FOR UPDATE`;
          templateLocked();
          await blockedActivation;
          await tx.$queryRaw`SELECT "id" FROM "template_versions" WHERE "id" = ${version.id} FOR UPDATE`;
          await released;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
      await lockedTemplate;
      const activation = Promise.resolve(
        call('post', `/templates/${templateId}/activate`),
      );
      await waitForBlocked(1);
      activationBlocked();
      const response = await activation;
      release();
      await holding;

      expect(response.status).toBe(409);
      expect(response.body.message).toBe(transactionConflictMessage);
      // No SQLSTATE, Prisma code, or SQL text reaches the client.
      expect(JSON.stringify(response.body)).not.toMatch(
        /40P01|deadlock|P2010|SELECT|FOR UPDATE|template_versions/i,
      );
      const draft = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(draft.immutableAt).toBeNull();
      // Nothing from the aborted activation was applied to the template row.
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template).toMatchObject({
        status: 'DRAFT',
        activeVersionNumber: null,
        currentVersionNumber: 1,
      });
      expect(await auditRows(templateId, 'template.activated')).toHaveLength(0);
    });

    it('maps a real transaction timeout (P2028) to 503 and the field is not created', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const versionLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "template_versions" WHERE "id" = ${version.id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
      await versionLocked;
      const started = Date.now();
      const addition = Promise.resolve(
        call('post', `/templates/${templateId}/fields`, {
          key: 'timed_out',
          label: 'Timed out',
          type: 'TEXT',
        }),
      );
      await waitForBlocked(1);
      // Hold the lock past the app's default 5 s interactive-transaction
      // timeout; this scenario is inherently time-based.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 5_750 - (Date.now() - started))),
      );
      release();
      await holding;
      const response = await addition;

      expect(response.status).toBe(503);
      expect(response.body.message).toBe(transactionUnconfirmedMessage);
      expect(
        await prisma.templateField.count({
          where: { versionId: version.id, key: 'timed_out' },
        }),
      ).toBe(0);
      expect(await auditRows(templateId, 'template.field_added')).toHaveLength(
        1, // only the fixture's 'headline' field
      );
      // The connection pool recovers: the same request now succeeds.
      await call('post', `/templates/${templateId}/fields`, {
        key: 'after_timeout',
        label: 'After timeout',
        type: 'TEXT',
      }).expect(201);
    });
  });
});

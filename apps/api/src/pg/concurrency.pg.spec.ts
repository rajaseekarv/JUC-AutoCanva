import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';

// Real-PostgreSQL concurrency tests. They run only in the `pg` Vitest
// project, which exists only when ADFLOW_PG_TEST_URL is set, and refuse to
// touch any database that is not the isolated 127.0.0.1:55432 *_test
// database stamped with this run's marker.
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

// Read-only identity check against the server itself; runs before any write.
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

type Lock = (tx: Prisma.TransactionClient) => Promise<unknown>;
type QueryLogClient = {
  $on(event: 'query', listener: (event: Prisma.QueryEvent) => void): void;
};

const lockVersionRow =
  (versionId: string): Lock =>
  (tx) =>
    tx.$queryRaw`SELECT "id" FROM "template_versions" WHERE "id" = ${versionId} FOR UPDATE`;
const lockTemplateRow =
  (templateId: string): Lock =>
  (tx) =>
    tx.$queryRaw`SELECT "id" FROM "templates" WHERE "id" = ${templateId} FOR UPDATE`;
const lockCanvaJobRow =
  (jobId: string): Lock =>
  (tx) =>
    tx.$queryRaw`SELECT "id" FROM "canva_jobs" WHERE "id" = ${jobId} FOR UPDATE`;

describe('Real PostgreSQL concurrency (isolated test database)', () => {
  let observer: PrismaClient;
  let holder: PrismaClient;
  let prisma: PrismaService;
  let app: INestApplication;
  let token = '';
  const queries: string[] = [];
  const runId = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const fixture = { organizationId: '', branchId: '', userId: '' };
  let templateCount = 0;

  beforeAll(async () => {
    assertIsolatedUrl(isolated.url);
    observer = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(observer);
    holder = new PrismaClient({ datasourceUrl: isolated.url });
    await assertIsolatedServer(holder);

    // Enough pooled connections for every request to wait on a lock at once.
    const appUrl = new URL(isolated.url);
    appUrl.searchParams.set('connection_limit', '12');
    prisma = new PrismaService({
      datasourceUrl: appUrl.toString(),
      log: [{ emit: 'event', level: 'query' }],
    });
    await assertIsolatedServer(prisma);
    (prisma as unknown as QueryLogClient).$on('query', (event) => {
      queries.push(event.query);
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();

    // Fixtures are written only after every identity check has passed.
    const organization = await prisma.organization.create({
      data: { name: 'PG isolation org', code: `pg-${runId}` },
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
        name: `pg-admin-${runId}`,
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
        name: 'PG admin',
        email: `pg-admin-${runId}@example.test`,
        roleAssignments: { create: { roleId: role.id } },
      },
    });
    const branch = await prisma.branch.create({
      data: { organizationId: organization.id, name: 'North', code: 'NORTH' },
    });
    await prisma.userBranchAccess.create({
      data: { userId: user.id, branchId: branch.id },
    });
    const session = await prisma.authSession.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    Object.assign(fixture, {
      organizationId: organization.id,
      branchId: branch.id,
      userId: user.id,
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
    method: 'get' | 'post' | 'patch' | 'delete',
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

  // Backends in this database currently waiting on a lock, excluding the
  // observer itself.
  async function waitForBlocked(count: number): Promise<string[]> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await observer.$queryRaw<Array<{ query: string }>>`
        SELECT query FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()`;
      if (rows.length >= count) return rows.map((row) => row.query);
      if (Date.now() > deadline)
        throw new Error(
          `Expected ${count} blocked backends, saw ${rows.length}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // Holds `lock` in a separate transaction, starts each request in order once
  // every earlier one is confirmed blocked in pg_stat_activity, then releases
  // the lock so PostgreSQL decides the outcome.
  async function serialized(lock: Lock, starts: Array<() => request.Test>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holding = holder.$transaction(
      async (tx) => {
        await lock(tx);
        acquired();
        await released;
      },
      { timeout: 30_000, maxWait: 5_000 },
    );
    await Promise.race([ready, holding]);
    const pending: Array<Promise<request.Response>> = [];
    let blocked: string[] = [];
    try {
      for (const start of starts) {
        pending.push(Promise.resolve(start()));
        blocked = await waitForBlocked(pending.length);
      }
    } catch (error) {
      release();
      await holding;
      await Promise.allSettled(pending);
      throw error;
    }
    release();
    await holding;
    return { responses: await Promise.all(pending), blocked };
  }

  async function draftTemplate(fieldKeys: string[] = ['headline']) {
    templateCount += 1;
    const created = await call('post', '/templates', {
      name: `Template ${templateCount}`,
      code: `pg-${runId}-${templateCount}`,
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

  const auditCount = (entityId: string, action: string) =>
    prisma.auditLog.count({ where: { entityId, action } });
  const statuses = (responses: request.Response[]) =>
    responses.map((response) => response.status);

  describe('template lifecycle locking', () => {
    it('lets only one of two concurrent activations succeed', async () => {
      const { templateId, version } = await draftTemplate();
      const activate = () => call('post', `/templates/${templateId}/activate`);
      const { responses } = await serialized(lockVersionRow(version.id), [
        activate,
        activate,
      ]);
      expect(statuses(responses)).toEqual([201, 409]);
      expect(responses[1].body.message).toBe(
        'This template version has already been activated',
      );
      const frozen = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(frozen.immutableAt).not.toBeNull();
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template).toMatchObject({
        status: 'ACTIVE',
        activeVersionNumber: 1,
      });
      expect(await auditCount(templateId, 'template.activated')).toBe(1);
    });

    it('includes a field added before activation in the frozen version', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const { responses } = await serialized(lockVersionRow(version.id), [
        () =>
          call('post', `/templates/${templateId}/fields`, {
            key: 'offer',
            label: 'Offer',
            type: 'TEXT',
          }),
        () => call('post', `/templates/${templateId}/activate`),
      ]);
      expect(statuses(responses)).toEqual([201, 201]);
      const frozen = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
        include: { fields: { orderBy: { displayOrder: 'asc' } } },
      });
      expect(frozen.immutableAt).not.toBeNull();
      expect(frozen.fields.map((field) => field.key)).toEqual([
        'headline',
        'offer',
      ]);
      expect(await auditCount(templateId, 'template.activated')).toBe(1);
    });

    it('rejects add, update, and remove queued behind an activation', async () => {
      const { templateId, version } = await draftTemplate([
        'headline',
        'extra',
      ]);
      const extra = version.fields.find((field) => field.key === 'extra')!;
      const { responses } = await serialized(lockVersionRow(version.id), [
        () => call('post', `/templates/${templateId}/activate`),
        () =>
          call('post', `/templates/${templateId}/fields`, {
            key: 'late',
            label: 'Late',
            type: 'TEXT',
          }),
        () =>
          call('patch', `/templates/${templateId}/fields/${extra.id}`, {
            label: 'Changed after freeze',
          }),
        () => call('delete', `/templates/${templateId}/fields/${extra.id}`),
      ]);
      expect(statuses(responses)).toEqual([201, 409, 409, 409]);
      for (const rejected of responses.slice(1))
        expect(rejected.body.message).toBe(
          'The current template version is immutable; create a new draft version to edit it',
        );
      const fields = await prisma.templateField.findMany({
        where: { versionId: version.id },
        orderBy: { displayOrder: 'asc' },
      });
      expect(fields.map((field) => [field.key, field.label])).toEqual([
        ['headline', 'headline'],
        ['extra', 'extra'],
      ]);
    });

    it('rejects activation after the last field is removed first', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const [onlyField] = version.fields;
      const { responses } = await serialized(lockVersionRow(version.id), [
        () => call('delete', `/templates/${templateId}/fields/${onlyField.id}`),
        () => call('post', `/templates/${templateId}/activate`),
      ]);
      expect(statuses(responses)).toEqual([200, 400]);
      expect(responses[1].body.message).toBe(
        'A template needs at least one field before activation',
      );
      const draft = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(draft.immutableAt).toBeNull();
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template.status).toBe('DRAFT');
      expect(await auditCount(templateId, 'template.activated')).toBe(0);
    });

    it('creates one field when two requests add the same key concurrently', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const addPromo = () =>
        call('post', `/templates/${templateId}/fields`, {
          key: 'promo',
          label: 'Promo',
          type: 'TEXT',
        });
      const { responses } = await serialized(lockVersionRow(version.id), [
        addPromo,
        addPromo,
      ]);
      expect(statuses(responses)).toEqual([201, 409]);
      expect(responses[1].body.message).toBe(
        'Field key already exists in this version',
      );
      expect(
        await prisma.templateField.count({
          where: { versionId: version.id, key: 'promo' },
        }),
      ).toBe(1);
    });

    it('assigns distinct default display orders to concurrent field additions', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const add = (key: string) => () =>
        call('post', `/templates/${templateId}/fields`, {
          key,
          label: key,
          type: 'TEXT',
        });
      const { responses } = await serialized(lockVersionRow(version.id), [
        add('first_added'),
        add('second_added'),
      ]);
      expect(statuses(responses)).toEqual([201, 201]);
      const fields = await prisma.templateField.findMany({
        where: { versionId: version.id },
        orderBy: { displayOrder: 'asc' },
      });
      expect(fields.map((field) => [field.key, field.displayOrder])).toEqual([
        ['headline', 0],
        ['first_added', 1],
        ['second_added', 2],
      ]);
    });

    it('creates one draft version when two createVersion requests race', async () => {
      const { templateId } = await draftTemplate(['headline']);
      await call('post', `/templates/${templateId}/activate`).expect(201);
      const createVersion = () =>
        call('post', `/templates/${templateId}/versions`);
      const { responses } = await serialized(lockTemplateRow(templateId), [
        createVersion,
        createVersion,
      ]);
      expect(statuses(responses)).toEqual([201, 409]);
      expect(responses[1].body.message).toBe(
        'A new draft version was created concurrently; reload the template',
      );
      const versions = await prisma.templateVersion.findMany({
        where: { templateId },
        orderBy: { versionNumber: 'asc' },
      });
      expect(versions.map((entry) => entry.versionNumber)).toEqual([1, 2]);
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template.currentVersionNumber).toBe(2);
      expect(await auditCount(templateId, 'template.version_created')).toBe(1);
    });

    it('does not reactivate a template archived before activation took its lock', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const { responses } = await serialized(lockTemplateRow(templateId), [
        () => call('post', `/templates/${templateId}/archive`),
        () => call('post', `/templates/${templateId}/activate`),
      ]);
      expect(statuses(responses)).toEqual([201, 409]);
      expect(responses[1].body.message).toBe(
        'Archived templates cannot be edited',
      );
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template.status).toBe('ARCHIVED');
      const draft = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(draft.immutableAt).toBeNull();
      expect(await auditCount(templateId, 'template.archived')).toBe(1);
      expect(await auditCount(templateId, 'template.activated')).toBe(0);
    });

    it('keeps an archive that is queued behind an activation', async () => {
      const { templateId } = await draftTemplate(['headline']);
      const { responses } = await serialized(lockTemplateRow(templateId), [
        () => call('post', `/templates/${templateId}/activate`),
        () => call('post', `/templates/${templateId}/archive`),
      ]);
      expect(statuses(responses)).toEqual([201, 201]);
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template.status).toBe('ARCHIVED');
      expect(await auditCount(templateId, 'template.activated')).toBe(1);
      expect(await auditCount(templateId, 'template.archived')).toBe(1);
    });

    it('rejects a metadata update when the template was archived first', async () => {
      const { templateId } = await draftTemplate(['headline']);
      const { responses } = await serialized(lockTemplateRow(templateId), [
        () => call('post', `/templates/${templateId}/archive`),
        () => call('patch', `/templates/${templateId}`, { name: 'Renamed' }),
      ]);
      expect(statuses(responses)).toEqual([201, 409]);
      expect(responses[1].body.message).toBe(
        'Archived templates cannot be edited',
      );
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template).toMatchObject({
        status: 'ARCHIVED',
        name: `Template ${templateCount}`,
      });
      expect(await auditCount(templateId, 'template.updated')).toBe(0);
    });

    it('freezes metadata from an update that committed before activation locked', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const { responses } = await serialized(lockVersionRow(version.id), [
        () =>
          call('patch', `/templates/${templateId}`, {
            name: 'Committed name',
            width: 1200,
          }),
        () => call('post', `/templates/${templateId}/activate`),
      ]);
      expect(statuses(responses)).toEqual([200, 201]);
      const frozen = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(frozen.immutableAt).not.toBeNull();
      expect(frozen).toMatchObject({ name: 'Committed name', width: 1200 });
      expect(await auditCount(templateId, 'template.updated')).toBe(1);
      expect(await auditCount(templateId, 'template.activated')).toBe(1);
    });

    it('rejects a metadata update queued behind an activation', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      const originalName = `Template ${templateCount}`;
      const { responses } = await serialized(lockVersionRow(version.id), [
        () => call('post', `/templates/${templateId}/activate`),
        () => call('patch', `/templates/${templateId}`, { name: 'Too late' }),
      ]);
      expect(statuses(responses)).toEqual([201, 409]);
      const template = await prisma.template.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(template.name).toBe(originalName);
      const frozen = await prisma.templateVersion.findUniqueOrThrow({
        where: { id: version.id },
      });
      expect(frozen.name).toBe(originalName);
      expect(await auditCount(templateId, 'template.updated')).toBe(0);
    });
  });

  describe('Canva job finalization', () => {
    it('finalizes a QUEUED job once when two same-key retries race', async () => {
      const { templateId, version } = await draftTemplate(['headline']);
      await call('post', `/templates/${templateId}/activate`).expect(201);
      await call('post', '/integrations/canva/connect').expect(201);
      const creative = await prisma.creative.create({
        data: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          name: 'PG creative',
          createdById: fixture.userId,
          updatedById: fixture.userId,
        },
      });
      const revision = await prisma.creativeRevision.create({
        data: {
          creativeId: creative.id,
          revisionNumber: 1,
          templateVersionId: version.id,
          values: {},
          createdById: fixture.userId,
        },
      });
      await prisma.creative.update({
        where: { id: creative.id },
        data: { currentRevisionId: revision.id },
      });
      const idempotencyKey = `pg-retry-${runId}`;
      const job = await prisma.canvaJob.create({
        data: {
          organizationId: fixture.organizationId,
          branchId: fixture.branchId,
          creativeId: creative.id,
          creativeRevisionId: revision.id,
          idempotencyKey,
          createdById: fixture.userId,
          mode: 'MOCK',
        },
      });
      expect(job.status).toBe('QUEUED');

      queries.length = 0;
      const retry = () =>
        call('post', '/integrations/canva/jobs', {
          creativeId: creative.id,
        }).set('Idempotency-Key', idempotencyKey);
      const { responses, blocked } = await serialized(lockCanvaJobRow(job.id), [
        retry,
        retry,
      ]);

      expect(statuses(responses)).toEqual([201, 201]);
      for (const response of responses)
        expect(response.body).toMatchObject({
          id: job.id,
          status: 'SUCCEEDED',
          externalDesignId: `mock-design-${revision.id}`,
        });
      const persisted = await prisma.canvaJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(persisted).toMatchObject({
        status: 'SUCCEEDED',
        externalDesignId: `mock-design-${revision.id}`,
      });
      expect(await auditCount(job.id, 'canva.design.prepared')).toBe(1);
      expect(await auditCount(job.id, 'canva.design.failed')).toBe(0);

      // Both retries were blocked inside the conditional UPDATE itself.
      const blockedUpdates = blocked.filter((sql) =>
        /UPDATE\s+"public"\."canva_jobs"/i.test(sql),
      );
      expect(blockedUpdates).toHaveLength(2);
      // Every UPDATE Prisma emitted for the job keeps the status predicate in
      // its WHERE clause, so PostgreSQL re-checks it after the lock wait.
      const emittedUpdates = queries.filter((sql) =>
        /^UPDATE\s+"public"\."canva_jobs"/i.test(sql),
      );
      expect(emittedUpdates).toHaveLength(2);
      for (const sql of [...emittedUpdates, ...blockedUpdates]) {
        const where = sql.slice(sql.search(/\sWHERE\s/i));
        expect(where).toMatch(/"canva_jobs"\."id"\s*=/);
        expect(where).toMatch(/"canva_jobs"\."status"\s*=/);
      }
      console.info(
        '[pg evidence] canva_jobs finalize UPDATE:',
        emittedUpdates[0],
      );
    });
  });
});

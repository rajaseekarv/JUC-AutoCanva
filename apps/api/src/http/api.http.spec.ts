import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { Readable } from 'node:stream';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppModule } from '../app.module';
import { ASSET_STORAGE } from '../assets/asset-storage';
import { PERMISSIONS } from '../auth/permissions';
import { PrismaService } from '../prisma/prisma.service';
import {
  transactionConflictMessage,
  transactionUnconfirmedMessage,
} from '../prisma/transaction-errors';

// Runs before any import is evaluated. If anything ever constructed a real
// PrismaClient here, it would target a closed local port instead of the
// development database from .env, and the JWT secret is test-only.
const blockedDatabaseUrl = vi.hoisted(() => {
  const url = 'postgresql://http-tests-must-not-connect@127.0.0.1:1/blocked';
  process.env.DATABASE_URL = url;
  process.env.JWT_ACCESS_SECRET =
    'http-test-only-secret-value-at-least-32-characters';
  return url;
});

type MockFn = ReturnType<typeof vi.fn>;

// Nest probes providers for these members; everything else must be mocked
// explicitly, so an unexpected database call fails the test instead of
// silently returning undefined.
const probedMembers = new Set([
  'then',
  'constructor',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

function strict<T extends object>(name: string, target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (
        typeof property === 'symbol' ||
        property in object ||
        probedMembers.has(property)
      )
        return Reflect.get(object, property, receiver);
      throw new Error(`Unmocked Prisma access: ${name}.${property}`);
    },
  });
}

const prismaRoot: Record<string, unknown> = {};
const prismaMock = strict('prisma', prismaRoot);
const models = new Map<string, Record<string, MockFn>>();

function model(name: string): Record<string, MockFn> {
  const existing = models.get(name);
  if (existing) return existing;
  const created: Record<string, MockFn> = {};
  models.set(name, created);
  prismaRoot[name] = strict(name, created);
  return created;
}

function resetPrismaMock(): void {
  for (const key of Object.keys(prismaRoot)) delete prismaRoot[key];
  models.clear();
}

let grantedPermissions: string[] = [];

function mockSession(): void {
  model('authSession').findFirst = vi.fn(async () => ({
    id: 'session-1',
    user: {
      id: 'user-1',
      organizationId: 'org-1',
      name: 'Operator',
      email: 'operator@example.local',
      status: 'ACTIVE',
      branchAccess: [
        {
          branch: {
            id: 'branch-1',
            organizationId: 'org-1',
            status: 'ACTIVE',
            name: 'North',
            code: 'NORTH',
          },
        },
      ],
      roleAssignments: [
        {
          role: {
            organizationId: 'org-1',
            permissions: grantedPermissions.map((code) => ({
              permission: { code },
            })),
          },
        },
      ],
    },
  }));
}

function uniqueViolation(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

describe('HTTP API with mocked Prisma', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await app
      .get(JwtService)
      .signAsync({ sub: 'user-1', sid: 'session-1' });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    resetPrismaMock();
    grantedPermissions = [];
    mockSession();
  });

  const server = () => app.getHttpServer();
  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('serves every request from the Prisma mock, never a real client', () => {
    const resolved = app.get(PrismaService);
    expect(resolved).toBe(prismaMock);
    expect(resolved).not.toBeInstanceOf(PrismaClient);
    expect(process.env.DATABASE_URL).toBe(blockedDatabaseUrl);
    expect(() => Reflect.get(prismaMock, 'user')).toThrow(
      'Unmocked Prisma access: prisma.user',
    );
  });

  describe('authentication', () => {
    it('rejects requests without a bearer token', async () => {
      await request(server())
        .get('/api/v1/integrations/canva/jobs')
        .expect(401);
      await request(server())
        .post('/api/v1/templates/template-1/activate')
        .expect(401);
      expect(model('authSession').findFirst).not.toHaveBeenCalled();
    });

    it('rejects a token that does not verify', async () => {
      await request(server())
        .get('/api/v1/integrations/canva/jobs')
        .set('Authorization', 'Bearer not-a-valid-token')
        .expect(401);
      expect(model('authSession').findFirst).not.toHaveBeenCalled();
    });

    it('rejects a valid token whose session is revoked or expired', async () => {
      model('authSession').findFirst = vi.fn(async () => null);
      await request(server())
        .get('/api/v1/integrations/canva/jobs')
        .set(auth())
        .expect(401);
      expect(model('authSession').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'session-1',
            userId: 'user-1',
            revokedAt: null,
          }),
        }),
      );
    });
  });

  describe('authorization', () => {
    it('returns 403 from the permission guard before the template service runs', async () => {
      grantedPermissions = [PERMISSIONS.TEMPLATE_READ];
      const response = await request(server())
        .post('/api/v1/templates/template-1/activate')
        .set(auth())
        .expect(403);
      expect(response.body.message).toBe('Permission denied');
      expect(models.has('template')).toBe(false);
    });

    it('returns 403 for Canva job creation without the job permission', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_READ];
      await request(server())
        .post('/api/v1/integrations/canva/jobs')
        .set(auth())
        .set('Idempotency-Key', 'idem-key-0001')
        .send({ creativeId: 'creative-1' })
        .expect(403);
      expect(models.has('creative')).toBe(false);
    });

    it('returns 403 from the branch guard for a branch outside the user grants', async () => {
      grantedPermissions = [PERMISSIONS.BRAND_READ];
      model('userBranchAccess').findFirst = vi.fn(async () => null);
      const response = await request(server())
        .get('/api/v1/branches/branch-2/brand')
        .set(auth())
        .expect(403);
      expect(response.body.message).toBe('Branch access denied');
      expect(model('userBranchAccess').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user-1',
            branchId: 'branch-2',
          }),
        }),
      );
    });

    it('hides a creative in an ungranted branch from Canva job creation', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_JOB_CREATE];
      model('creative').findFirst = vi.fn(async () => ({
        id: 'creative-1',
        organizationId: 'org-1',
        branchId: 'branch-2',
        currentRevision: { id: 'revision-1' },
      }));
      model('userBranchAccess').findFirst = vi.fn(async () => null);
      const response = await request(server())
        .post('/api/v1/integrations/canva/jobs')
        .set(auth())
        .set('Idempotency-Key', 'idem-key-0001')
        .send({ creativeId: 'creative-1' })
        .expect(404);
      expect(response.body.message).toBe('Creative not found');
      expect(models.has('canvaJob')).toBe(false);
    });
  });

  describe('Canva job request validation', () => {
    beforeEach(() => {
      grantedPermissions = [PERMISSIONS.CANVA_JOB_CREATE];
    });

    it.each([
      ['missing', undefined],
      ['too short', 'short'],
      ['containing unsafe characters', 'idem key with spaces'],
    ])('rejects a %s Idempotency-Key with 400', async (_case, key) => {
      const pending = request(server())
        .post('/api/v1/integrations/canva/jobs')
        .set(auth());
      if (key) pending.set('Idempotency-Key', key);
      const response = await pending.send({ creativeId: 'creative-1' });
      expect(response.status).toBe(400);
      expect(response.body.message).toBe('A valid Idempotency-Key is required');
      expect(models.has('creative')).toBe(false);
    });

    it('rejects an invalid job body with 400', async () => {
      const response = await request(server())
        .post('/api/v1/integrations/canva/jobs')
        .set(auth())
        .set('Idempotency-Key', 'idem-key-0001')
        .send({ creativeId: 'creative-1', unexpected: true })
        .expect(400);
      expect(response.body.message).toBe('Invalid Canva job');
    });
  });

  it('passes the Canva 503 for an unsaved outcome through to the client', async () => {
    grantedPermissions = [PERMISSIONS.CANVA_JOB_CREATE];
    model('creative').findFirst = vi.fn(async () => ({
      id: 'creative-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      currentRevision: {
        id: 'revision-1',
        revisionNumber: 1,
        templateVersionId: 'template-version-1',
        templateVersion: { name: 'Social square' },
      },
    }));
    model('userBranchAccess').findFirst = vi.fn(async () => ({
      branchId: 'branch-1',
    }));
    model('canvaConnection').findUnique = vi.fn(async () => ({
      status: 'CONNECTED',
    }));
    model('canvaJob').findUnique = vi.fn(async () => null);
    model('canvaJob').create = vi.fn(async () => ({
      id: 'job-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      creativeId: 'creative-1',
      creativeRevisionId: 'revision-1',
      status: 'QUEUED',
      mode: 'MOCK',
    }));
    prismaRoot.$transaction = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const response = await request(server())
      .post('/api/v1/integrations/canva/jobs')
      .set(auth())
      .set('Idempotency-Key', 'idem-key-0001')
      .send({ creativeId: 'creative-1' })
      .expect(503);
    expect(response.body.message).toMatch(
      /retry with the same Idempotency-Key/,
    );
    expect(JSON.stringify(response.body)).not.toContain('connection lost');
    expect(model('canvaJob').create).toHaveBeenCalledTimes(1);
  });

  it('returns the Canva 409 message when a key was used for another creative', async () => {
    grantedPermissions = [PERMISSIONS.CANVA_JOB_CREATE];
    model('creative').findFirst = vi.fn(async () => ({
      id: 'creative-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      currentRevision: { id: 'revision-1' },
    }));
    model('userBranchAccess').findFirst = vi.fn(async () => ({
      branchId: 'branch-1',
    }));
    model('canvaConnection').findUnique = vi.fn(async () => ({
      status: 'CONNECTED',
    }));
    model('canvaJob').findUnique = vi.fn(async () => ({
      id: 'job-1',
      creativeId: 'creative-other',
      status: 'QUEUED',
    }));
    const response = await request(server())
      .post('/api/v1/integrations/canva/jobs')
      .set(auth())
      .set('Idempotency-Key', 'idem-key-0001')
      .send({ creativeId: 'creative-1' })
      .expect(409);
    expect(response.body.message).toBe('Idempotency key already used');
  });

  describe('template conflicts', () => {
    it('returns 409 when a concurrent request already created the draft version', async () => {
      grantedPermissions = [PERMISSIONS.TEMPLATE_EDIT];
      model('template').findFirst = vi.fn(async () => ({
        id: 'template-1',
        organizationId: 'org-1',
        status: 'ACTIVE',
        currentVersionNumber: 1,
        activeVersionNumber: 1,
      }));
      model('templateVersion').findUnique = vi.fn(async () => ({
        id: 'version-1',
        versionNumber: 1,
        immutableAt: new Date(),
        fields: [],
      }));
      prismaRoot.$transaction = vi.fn(async () => {
        throw uniqueViolation(['templateId', 'versionNumber']);
      });
      const response = await request(server())
        .post('/api/v1/templates/template-1/versions')
        .set(auth())
        .expect(409);
      expect(response.body.message).toMatch(/created concurrently/);
    });

    it('returns 409 without writes when a competing activation froze the version first', async () => {
      grantedPermissions = [PERMISSIONS.TEMPLATE_ACTIVATE];
      model('template').findFirst = vi.fn(async () => ({
        id: 'template-1',
        organizationId: 'org-1',
        status: 'DRAFT',
        currentVersionNumber: 1,
        activeVersionNumber: null,
        name: 'Social',
        code: 'social',
        formatName: 'Square',
        width: 1080,
        height: 1080,
      }));
      model('templateVersion').findUnique = vi.fn(async () => ({
        id: 'version-1',
        versionNumber: 1,
        immutableAt: null,
        fields: [{ id: 'field-1' }],
      }));
      // Only the lock is mocked: any write inside the transaction would hit
      // the strict proxy and turn this into a 500.
      const transaction = strict('tx', {
        $queryRaw: vi.fn(async () => []),
      });
      prismaRoot.$transaction = vi.fn(
        async (work: (tx: typeof transaction) => Promise<unknown>) =>
          work(transaction),
      );
      const response = await request(server())
        .post('/api/v1/templates/template-1/activate')
        .set(auth())
        .expect(409);
      expect(response.body.message).toBe(
        'This template version has already been activated',
      );
    });

    it('returns 409 without writes when the template was archived before a metadata update locked it', async () => {
      grantedPermissions = [PERMISSIONS.TEMPLATE_EDIT];
      const draftTemplate = {
        id: 'template-1',
        organizationId: 'org-1',
        status: 'DRAFT',
        currentVersionNumber: 1,
        width: 1080,
        height: 1080,
        code: 'social',
      };
      model('template').findFirst = vi.fn(async () => draftTemplate);
      model('templateVersion').findUnique = vi.fn(async () => ({
        id: 'version-1',
        versionNumber: 1,
        immutableAt: null,
        fields: [],
      }));
      // Both locks succeed, but the row re-read under the template lock shows
      // the archive that committed first. No template update or audit write
      // is mocked, so any write would surface as a 500.
      const transaction = strict('tx', {
        $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
        template: strict('tx.template', {
          findUniqueOrThrow: vi.fn(async () => ({
            ...draftTemplate,
            status: 'ARCHIVED',
          })),
        }),
      });
      prismaRoot.$transaction = vi.fn(
        async (work: (tx: typeof transaction) => Promise<unknown>) =>
          work(transaction),
      );
      const response = await request(server())
        .patch('/api/v1/templates/template-1')
        .set(auth())
        .send({ name: 'Renamed' })
        .expect(409);
      expect(response.body.message).toBe('Archived templates cannot be edited');
    });

    describe('draft version changes', () => {
      const draftTemplate = {
        id: 'template-1',
        organizationId: 'org-1',
        status: 'DRAFT',
        currentVersionNumber: 1,
        activeVersionNumber: null,
        name: 'Social',
        code: 'social',
        formatName: 'Square',
        width: 1080,
        height: 1080,
      };
      const headline = {
        id: 'field-1',
        versionId: 'version-1',
        key: 'headline',
        label: 'Headline',
        type: 'TEXT',
        displayOrder: 0,
        dataSource: null,
        sourceKey: null,
      };

      beforeEach(() => {
        grantedPermissions = [
          PERMISSIONS.TEMPLATE_EDIT,
          PERMISSIONS.TEMPLATE_ACTIVATE,
        ];
        model('template').findFirst = vi.fn(async () => draftTemplate);
        model('templateVersion').findUnique = vi.fn(async () => ({
          id: 'version-1',
          versionNumber: 1,
          immutableAt: null,
          fields: [headline],
        }));
      });

      // Runs the service's transaction callback against a strict client, so
      // any write that is not mocked fails the request with a 500.
      function transactionWith(client: Record<string, unknown>) {
        const transaction = strict('tx', client);
        prismaRoot.$transaction = vi.fn(
          async (work: (tx: typeof transaction) => Promise<unknown>) =>
            work(transaction),
        );
      }

      const fieldChanges = [
        [
          'add',
          () =>
            request(server())
              .post('/api/v1/templates/template-1/fields')
              .send({ key: 'offer', label: 'Offer', type: 'TEXT' }),
        ],
        [
          'update',
          () =>
            request(server())
              .patch('/api/v1/templates/template-1/fields/field-1')
              .send({ label: 'Main headline' }),
        ],
        [
          'remove',
          () =>
            request(server()).delete(
              '/api/v1/templates/template-1/fields/field-1',
            ),
        ],
      ] as const;

      it.each(fieldChanges)(
        'returns 409 without field writes when the version froze before %s locked it',
        async (_action, send) => {
          // The draft-version lock finds no unfrozen row.
          transactionWith({ $queryRaw: vi.fn(async () => []) });
          const response = await send().set(auth()).expect(409);
          expect(response.body.message).toBe(
            'The current template version is immutable; create a new draft version to edit it',
          );
        },
      );

      it.each(fieldChanges.slice(0, 2))(
        'returns 409 when the field key collides on %s',
        async (_action, send) => {
          prismaRoot.$transaction = vi.fn(async () => {
            throw uniqueViolation(['versionId', 'key']);
          });
          const response = await send().set(auth()).expect(409);
          expect(response.body.message).toBe(
            'Field key already exists in this version',
          );
        },
      );

      it('returns 500 without detail for an unrelated unique conflict on a field write', async () => {
        prismaRoot.$transaction = vi.fn(async () => {
          throw uniqueViolation(['organizationId', 'code']);
        });
        const response = await fieldChanges[0][1]().set(auth()).expect(500);
        expect(JSON.stringify(response.body)).not.toMatch(
          /P2002|Unique constraint/,
        );
      });

      const lockedActivation = (client: Record<string, unknown>) =>
        transactionWith({
          $queryRaw: vi.fn(async () => [{ id: 'locked' }]),
          template: strict('tx.template', {
            findUniqueOrThrow: vi.fn(async () => draftTemplate),
          }),
          ...client,
        });

      it('returns 409 without template or audit writes when the conditional freeze changes no row', async () => {
        // No template update or audit write is mocked.
        lockedActivation({
          templateField: strict('tx.templateField', {
            count: vi.fn(async () => 1),
          }),
          templateVersion: strict('tx.templateVersion', {
            updateMany: vi.fn(async () => ({ count: 0 })),
          }),
        });
        const response = await request(server())
          .post('/api/v1/templates/template-1/activate')
          .set(auth())
          .expect(409);
        expect(response.body.message).toBe(
          'This template version has already been activated',
        );
      });

      it('returns 400 without freezing when no fields remain inside the activation transaction', async () => {
        // The pre-check saw a field; the count under the lock sees none.
        lockedActivation({
          templateField: strict('tx.templateField', {
            count: vi.fn(async () => 0),
          }),
        });
        const response = await request(server())
          .post('/api/v1/templates/template-1/activate')
          .set(auth())
          .expect(400);
        expect(response.body.message).toBe(
          'A template needs at least one field before activation',
        );
      });
    });
  });

  describe('Canva OAuth in mock mode (the default)', () => {
    it('requires authentication to start OAuth', async () => {
      await request(server())
        .post('/api/v1/integrations/canva/oauth/authorize')
        .expect(401);
    });

    it('requires the integration-management permission to start OAuth', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_READ];
      const response = await request(server())
        .post('/api/v1/integrations/canva/oauth/authorize')
        .set(auth())
        .expect(403);
      expect(response.body.message).toBe('Permission denied');
    });

    it('refuses to start OAuth while the mock provider is active', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_MANAGE];
      const response = await request(server())
        .post('/api/v1/integrations/canva/oauth/authorize')
        .set(auth())
        .expect(409);
      expect(response.body.message).toBe(
        'Canva OAuth is disabled while the mock provider is active',
      );
    });

    it('answers the unauthenticated callback with a fixed, uncached redirect', async () => {
      const response = await request(server())
        .get('/api/v1/integrations/canva/oauth/callback')
        .query({
          state: 'A'.repeat(43),
          code: 'test-code',
          redirect_uri: 'https://attacker.example/',
        })
        .expect(303);
      expect(response.headers.location).toBe(
        'http://localhost:5173/?canva=disabled#canva-integration',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      // No session lookup: the callback never trusts or needs a JWT.
      expect(
        models.has('authSession') && model('authSession').findFirst,
      ).not.toHaveBeenCalled();
    });

    it('answers the unauthenticated launch form post with a fixed redirect', async () => {
      const response = await request(server())
        .post('/api/v1/integrations/canva/oauth/launch')
        .type('form')
        .send({ launch_token: 'A'.repeat(43) })
        .expect(303);
      expect(response.headers.location).toBe(
        'http://localhost:5173/?canva=disabled#canva-integration',
      );
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('refuses the confirmation routes while the mock provider is active', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_MANAGE];
      await request(server())
        .get('/api/v1/integrations/canva/oauth/candidate')
        .set(auth())
        .expect(409);
    });
  });

  describe('Canva in real mode (test-only configuration)', () => {
    // Placeholders only; no real Canva credentials exist in tests.
    const realModeEnv = {
      CANVA_PROVIDER_MODE: 'canva',
      CANVA_CLIENT_ID: 'OC-test-client-id',
      CANVA_CLIENT_SECRET: 'test-only-client-secret-value',
      CANVA_REDIRECT_URI:
        'http://127.0.0.1:3000/api/v1/integrations/canva/oauth/callback',
      CANVA_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    };
    let realApp: INestApplication;
    let realToken: string;
    const saved: Record<string, string | undefined> = {};

    beforeAll(async () => {
      for (const [name, value] of Object.entries(realModeEnv)) {
        saved[name] = process.env[name];
        process.env[name] = value;
      }
      // Any network use would fail the test; none is expected.
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          throw new Error('Network access is not allowed in tests');
        }),
      );
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prismaMock)
        .compile();
      realApp = moduleRef.createNestApplication();
      realApp.setGlobalPrefix('api/v1');
      await realApp.init();
      realToken = await realApp
        .get(JwtService)
        .signAsync({ sub: 'user-1', sid: 'session-1' });
    });

    afterAll(async () => {
      await realApp?.close();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    const realServer = () => realApp.getHttpServer();
    const realAuth = () => ({ Authorization: `Bearer ${realToken}` });

    it('fails closed with 503 because durable OAuth storage is not available', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_MANAGE];
      const response = await request(realServer())
        .post('/api/v1/integrations/canva/oauth/authorize')
        .set(realAuth())
        .expect(503);
      expect(response.body.message).toBe(
        'Real Canva connection is not available yet',
      );
      expect(JSON.stringify(response.body)).not.toMatch(
        /test-only-client-secret|OC-test-client-id/,
      );
    });

    it('redirects a callback without the binding cookie as expired_or_used', async () => {
      const response = await request(realServer())
        .get('/api/v1/integrations/canva/oauth/callback')
        .query({ state: 'A'.repeat(43), code: 'test-code' })
        .expect(303);
      expect(response.headers.location).toBe(
        'http://localhost:5173/?canva=expired_or_used#canva-integration',
      );
    });

    it('redirects a callback with a binding cookie as unavailable while storage is off', async () => {
      const response = await request(realServer())
        .get('/api/v1/integrations/canva/oauth/callback')
        .set('Cookie', `adflow_canva_oauth_binding=${'B'.repeat(43)}`)
        .query({ state: 'A'.repeat(43), code: 'test-code' })
        .expect(303);
      expect(response.headers.location).toBe(
        'http://localhost:5173/?canva=unavailable#canva-integration',
      );
      // The single-use binding cookie is cleared on its path.
      expect(String(response.headers['set-cookie'])).toMatch(
        /adflow_canva_oauth_binding=;.*Path=\/api\/v1\/integrations\/canva\/oauth/,
      );
    });

    it('answers a launch form post with a fixed redirect and no cookie while storage is off', async () => {
      const response = await request(realServer())
        .post('/api/v1/integrations/canva/oauth/launch')
        .type('form')
        .send({
          launch_token: 'A'.repeat(43),
          redirect: 'https://evil.example',
        })
        .expect(303);
      expect(response.headers.location).toBe(
        'http://localhost:5173/?canva=unavailable#canva-integration',
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('requires authentication for the confirmation routes', async () => {
      await request(realServer())
        .get('/api/v1/integrations/canva/oauth/candidate')
        .expect(401);
      await request(realServer())
        .post('/api/v1/integrations/canva/oauth/candidate/confirm')
        .send({ candidateId: 'candidate-1' })
        .expect(401);
      await request(realServer())
        .post('/api/v1/integrations/canva/revocations/r1/retry')
        .expect(401);
    });

    it('requires the management permission for the confirmation routes', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_READ];
      await request(realServer())
        .get('/api/v1/integrations/canva/oauth/candidate')
        .set(realAuth())
        .expect(403);
      await request(realServer())
        .post('/api/v1/integrations/canva/oauth/candidate/reject')
        .set(realAuth())
        .send({ candidateId: 'candidate-1' })
        .expect(403);
      await request(realServer())
        .post('/api/v1/integrations/canva/revocations/r1/dismiss')
        .set(realAuth())
        .expect(403);
    });

    it('fails closed with 503 on the confirmation routes while storage is off', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_MANAGE];
      const response = await request(realServer())
        .get('/api/v1/integrations/canva/oauth/candidate')
        .set(realAuth())
        .expect(503);
      expect(response.body.message).toBe(
        'Real Canva connection is not available yet',
      );
    });

    it('refuses real disconnection with 409 while storage is off', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_MANAGE];
      const response = await request(realServer())
        .post('/api/v1/integrations/canva/disconnect')
        .set(realAuth())
        .expect(409);
      expect(response.body.message).toBe(
        'Real Canva disconnection is not available yet',
      );
    });

    it('refuses the mock connect action and mock job creation with 409', async () => {
      grantedPermissions = [
        PERMISSIONS.CANVA_INTEGRATION_MANAGE,
        PERMISSIONS.CANVA_JOB_CREATE,
      ];
      const connect = await request(realServer())
        .post('/api/v1/integrations/canva/connect')
        .set(realAuth())
        .expect(409);
      expect(connect.body.message).toBe(
        'In real Canva mode, connect through Canva authorization',
      );
      const job = await request(realServer())
        .post('/api/v1/integrations/canva/jobs')
        .set(realAuth())
        .set('Idempotency-Key', 'idem-key-0001')
        .send({ creativeId: 'creative-1' })
        .expect(409);
      expect(job.body.message).toBe(
        'Real Canva design preparation is not available yet',
      );
      expect(models.has('canvaConnection')).toBe(false);
      expect(models.has('creative')).toBe(false);
    });

    it('reports real mode without treating a leftover mock connection as real', async () => {
      grantedPermissions = [PERMISSIONS.CANVA_INTEGRATION_READ];
      model('canvaConnection').findUnique = vi.fn(async () => ({
        status: 'CONNECTED',
        mode: 'MOCK',
        connectedAt: new Date(),
      }));
      const response = await request(realServer())
        .get('/api/v1/integrations/canva/status')
        .set(realAuth())
        .expect(200);
      expect(response.body).toMatchObject({
        mode: 'CANVA',
        status: 'DISCONNECTED',
        isRealConnection: false,
      });
    });
  });

  describe('review safeguards', () => {
    // Every model the request touches is mocked explicitly; anything else
    // (such as an approval decision write) fails the request with a 500.
    const useTransactionMock = () => {
      prismaRoot.$transaction = vi.fn(
        async (operation: (tx: unknown) => unknown) => operation(prismaMock),
      );
    };
    const grantBranch = () => {
      model('userBranchAccess').findFirst = vi.fn(async () => ({
        branchId: 'branch-1',
      }));
    };
    const reviewTask = (startedById: string) => ({
      id: 'task-1',
      instanceId: 'instance-1',
      stageId: 'stage-review',
      assignedUserId: 'user-1',
      requiredPermission: null,
      status: 'OPEN',
      stage: { id: 'stage-review', requiresReview: true },
      instance: {
        id: 'instance-1',
        branchId: 'branch-1',
        creativeId: 'creative-1',
        creativeRevisionId: 'revision-1',
        currentStageId: 'stage-review',
        status: 'RUNNING',
        startedById,
        creative: {
          id: 'creative-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          name: 'Spring post',
        },
      },
    });

    it.each(['APPROVED', 'CHANGES_REQUESTED'])(
      'refuses a %s decision by the user who started the run with 403 and no writes',
      async (decision) => {
        grantedPermissions = [
          PERMISSIONS.APPROVAL_DECIDE,
          PERMISSIONS.CHANGE_REQUEST_CREATE,
        ];
        mockSession();
        useTransactionMock();
        grantBranch();
        model('workflowTask').findFirst = vi.fn(async () =>
          reviewTask('user-1'),
        );
        const response = await request(server())
          .post('/api/v1/approvals/tasks/task-1/decision')
          .set(auth())
          .send({ decision, reason: 'Self review' })
          .expect(403);
        expect(response.body.message).toBe(
          'You cannot decide a review for a creative you submitted',
        );
      },
    );

    it('still requires the decide permission before looking at the task', async () => {
      grantedPermissions = [PERMISSIONS.APPROVAL_READ];
      mockSession();
      await request(server())
        .post('/api/v1/approvals/tasks/task-1/decision')
        .set(auth())
        .send({ decision: 'APPROVED' })
        .expect(403);
      expect(models.get('workflowTask')).toBeUndefined();
    });

    it('stores a reply to a reply under the original top-level comment', async () => {
      grantedPermissions = [PERMISSIONS.COMMENT_CREATE];
      mockSession();
      useTransactionMock();
      model('creative').findFirst = vi.fn(async () => ({
        id: 'creative-1',
        branchId: 'branch-1',
        name: 'Spring post',
      }));
      model('creativeRevision').findUnique = vi.fn(async () => ({
        id: 'revision-1',
      }));
      const stored = [
        { id: 'root', parentId: null },
        { id: 'reply-1', parentId: 'root' },
      ];
      model('creativeComment').findFirst = vi.fn(
        async ({ where }: { where: { id: string } }) =>
          stored.find((comment) => comment.id === where.id) ?? null,
      );
      model('creativeComment').create = vi.fn(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'comment-new',
          ...data,
          author: { id: 'user-1', name: 'Operator' },
        }),
      );
      model('auditLog').create = vi.fn(async () => ({}));
      model('workflowTask').findFirst = vi.fn(async () => null);
      model('workflowInstance').findFirst = vi.fn(async () => null);
      model('changeRequest').findMany = vi.fn(async () => []);
      const response = await request(server())
        .post('/api/v1/creatives/creative-1/revisions/1/comments')
        .set(auth())
        .send({ text: 'Agreed', parentId: 'reply-1' })
        .expect(201);
      expect(response.body.parentId).toBe('root');
      expect(model('creativeComment').create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ parentId: 'root' }),
        }),
      );
    });

    it('rejects a reply to a comment on another revision with 404', async () => {
      grantedPermissions = [PERMISSIONS.COMMENT_CREATE];
      mockSession();
      model('creative').findFirst = vi.fn(async () => ({
        id: 'creative-1',
        branchId: 'branch-1',
        name: 'Spring post',
      }));
      model('creativeRevision').findUnique = vi.fn(async () => ({
        id: 'revision-2',
      }));
      model('creativeComment').findFirst = vi.fn(async () => null);
      const response = await request(server())
        .post('/api/v1/creatives/creative-1/revisions/2/comments')
        .set(auth())
        .send({ text: 'Agreed', parentId: 'comment-on-revision-1' })
        .expect(404);
      expect(response.body.message).toBe('Comment thread not found');
    });

    it('requires comments:read, and hides creatives outside the caller branches', async () => {
      grantedPermissions = [PERMISSIONS.APPROVAL_READ];
      mockSession();
      await request(server())
        .get('/api/v1/creatives/creative-1/revisions/1/comments')
        .set(auth())
        .expect(403);
      grantedPermissions = [PERMISSIONS.COMMENT_READ];
      mockSession();
      model('creative').findFirst = vi.fn(async () => null);
      const response = await request(server())
        .get('/api/v1/creatives/creative-other/revisions/1/comments')
        .set(auth())
        .expect(404);
      expect(response.body.message).toBe('Creative not found');
      expect(model('creative').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-1',
            branch: {
              status: 'ACTIVE',
              users: { some: { userId: 'user-1' } },
            },
          }),
        }),
      );
    });

    it('lets a submitter read decisions and change requests for a creative in their branch', async () => {
      grantedPermissions = [
        PERMISSIONS.APPROVAL_READ,
        PERMISSIONS.CHANGE_REQUEST_READ,
      ];
      mockSession();
      model('creative').findFirst = vi.fn(async () => ({
        id: 'creative-1',
        branchId: 'branch-1',
        name: 'Spring post',
      }));
      model('approvalDecision').findMany = vi.fn(async () => [
        { id: 'decision-1', decision: 'CHANGES_REQUESTED' },
      ]);
      model('changeRequest').findMany = vi.fn(async () => [
        { id: 'request-1', status: 'OPEN' },
      ]);
      const decisions = await request(server())
        .get('/api/v1/creatives/creative-1/decisions')
        .set(auth())
        .expect(200);
      expect(decisions.body).toEqual([
        { id: 'decision-1', decision: 'CHANGES_REQUESTED' },
      ]);
      await request(server())
        .get('/api/v1/creatives/creative-1/change-requests')
        .set(auth())
        .expect(200);
    });
  });

  describe('asset content streaming', () => {
    // Storage is faked so these tests never read or write asset files.
    const storage = { put: vi.fn(), get: vi.fn(), remove: vi.fn() };
    let assetApp: INestApplication;
    let assetToken: string;
    const assetServer = () => assetApp.getHttpServer();
    const assetAuth = () => ({ Authorization: `Bearer ${assetToken}` });
    const storedAsset = (
      branchId: string | null = null,
      originalName = 'creative-final.png',
    ) => ({
      id: 'asset-1',
      organizationId: 'org-1',
      branchId,
      uploadedById: 'user-1',
      originalName,
      storageKey: 'generated.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      width: 1,
      height: 1,
      checksumSha256: 'hash',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    const expectServerAlive = () =>
      request(assetServer()).get('/api/v1/health').expect(200);

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prismaMock)
        .overrideProvider(ASSET_STORAGE)
        .useValue(storage)
        .compile();
      assetApp = moduleRef.createNestApplication();
      assetApp.setGlobalPrefix('api/v1');
      await assetApp.init();
      assetToken = await assetApp
        .get(JwtService)
        .signAsync({ sub: 'user-1', sid: 'session-1' });
    });

    afterAll(async () => {
      await assetApp?.close();
    });

    beforeEach(() => {
      grantedPermissions = [PERMISSIONS.ASSET_READ];
      storage.get.mockReset();
      model('asset').findFirst = vi.fn(async () => storedAsset());
    });

    it('streams stored content with its type and security headers', async () => {
      const bytes = Buffer.from([137, 80, 78, 71]);
      storage.get.mockResolvedValue(Readable.from([bytes]));
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toBe(
        'inline; filename="creative-final.png"',
      );
      expect(response.body).toEqual(bytes);
      expect(storage.get).toHaveBeenCalledWith('generated.png');
    });

    it('keeps CR and LF in a stored name from injecting a response header', async () => {
      model('asset').findFirst = vi.fn(async () =>
        storedAsset(null, 'banner\r\nSet-Cookie: session=stolen.png'),
      );
      storage.get.mockResolvedValue(Readable.from([Buffer.from([1])]));
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(200);
      expect(response.headers['content-disposition']).toBe(
        'inline; filename="bannerSet-Cookie: session=stolen.png"',
      );
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('serves a non-ASCII name with an ASCII fallback instead of failing', async () => {
      model('asset').findFirst = vi.fn(async () =>
        storedAsset(null, 'ロゴ.png'),
      );
      storage.get.mockResolvedValue(Readable.from([Buffer.from([1])]));
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(200);
      expect(response.headers['content-disposition']).toBe(
        'inline; filename="__.png"; filename*=UTF-8\'\'%E3%83%AD%E3%82%B4.png',
      );
    });

    it('answers 404 when the stored file is missing and keeps serving', async () => {
      storage.get.mockRejectedValue(
        Object.assign(new Error("ENOENT: no such file, open 'C:\\x.png'"), {
          code: 'ENOENT',
        }),
      );
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(404);
      expect(response.body.message).toBe('Asset content not found');
      expect(JSON.stringify(response.body)).not.toContain('x.png');
      await expectServerAlive();
    });

    it('answers 500 without detail when the stream fails before any data', async () => {
      storage.get.mockResolvedValue(
        new Readable({
          read() {
            this.destroy(new Error('EIO: i/o error, read'));
          },
        }),
      );
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(500);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(response.headers['content-disposition']).toBeUndefined();
      await expectServerAlive();
    });

    it('ends the response when the stream fails after data was sent', async () => {
      let sent = false;
      storage.get.mockResolvedValue(
        new Readable({
          read() {
            if (sent) {
              this.destroy(new Error('EIO: i/o error, read'));
              return;
            }
            sent = true;
            this.push(Buffer.alloc(16));
          },
        }),
      );
      // The status line is already sent, so the only safe outcome is a
      // truncated response or an aborted connection, never a second reply.
      await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .then(
          (response) => expect(response.status).toBe(200),
          (error: Error) => expect(error).toBeInstanceOf(Error),
        );
      await expectServerAlive();
    });

    it('keeps reporting a deleted asset as not found without opening storage', async () => {
      model('asset').findFirst = vi.fn(async () => null);
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(404);
      expect(response.body.message).toBe('Asset not found');
      expect(storage.get).not.toHaveBeenCalled();
    });

    it('still requires the read permission and branch access before opening storage', async () => {
      grantedPermissions = [];
      await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(403);
      grantedPermissions = [PERMISSIONS.ASSET_READ];
      model('asset').findFirst = vi.fn(async () => storedAsset('branch-2'));
      model('userBranchAccess').findFirst = vi.fn(async () => null);
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(403);
      expect(response.body.message).toBe('Branch access denied');
      expect(storage.get).not.toHaveBeenCalled();
    });

    it('keeps image bytes out of browser and proxy caches and unable to run as a page', async () => {
      storage.get.mockResolvedValue(Readable.from([Buffer.from([1])]));
      const response = await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; sandbox",
      );
    });

    it('serves a branch asset to a caller granted that branch', async () => {
      model('asset').findFirst = vi.fn(async () => storedAsset('branch-1'));
      model('userBranchAccess').findFirst = vi.fn(async () => ({
        branchId: 'branch-1',
      }));
      storage.get.mockResolvedValue(Readable.from([Buffer.from([1])]));
      await request(assetServer())
        .get('/api/v1/assets/asset-1/content')
        .set(assetAuth())
        .expect(200);
      expect(model('userBranchAccess').findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: 'user-1',
            branchId: 'branch-1',
          }),
        }),
      );
    });

    it('only looks up active assets in the caller organization', async () => {
      model('asset').findFirst = vi.fn(async () => null);
      await request(assetServer())
        .get('/api/v1/assets/other-org-asset/content')
        .set(assetAuth())
        .expect(404);
      expect(model('asset').findFirst).toHaveBeenCalledWith({
        where: {
          id: 'other-org-asset',
          organizationId: 'org-1',
          status: 'ACTIVE',
        },
      });
      expect(storage.get).not.toHaveBeenCalled();
    });

    describe('download (GET /assets/:assetId/download)', () => {
      it('sends the stored bytes as an attachment with the same protections', async () => {
        const bytes = Buffer.from([137, 80, 78, 71]);
        storage.get.mockResolvedValue(Readable.from([bytes]));
        const response = await request(assetServer())
          .get('/api/v1/assets/asset-1/download')
          .set(assetAuth())
          .buffer(true)
          .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => done(null, Buffer.concat(chunks)));
          })
          .expect(200);
        expect(response.headers['content-type']).toBe('image/png');
        expect(response.headers['content-disposition']).toBe(
          'attachment; filename="creative-final.png"',
        );
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.body).toEqual(bytes);
        expect(storage.get).toHaveBeenCalledWith('generated.png');
      });

      it('never reveals the storage key or a filesystem path', async () => {
        storage.get.mockRejectedValue(
          Object.assign(
            new Error("ENOENT: no such file, open 'C:\\store\\generated.png'"),
            { code: 'ENOENT' },
          ),
        );
        const response = await request(assetServer())
          .get('/api/v1/assets/asset-1/download')
          .set(assetAuth())
          .expect(404);
        expect(response.body.message).toBe('Asset content not found');
        expect(JSON.stringify(response.body)).not.toMatch(/generated|store/);
        expect(JSON.stringify(response.headers)).not.toContain('generated');
      });

      it('requires authentication', async () => {
        await request(assetServer())
          .get('/api/v1/assets/asset-1/download')
          .expect(401);
        expect(storage.get).not.toHaveBeenCalled();
      });

      it('requires the read permission before any lookup', async () => {
        grantedPermissions = [PERMISSIONS.ASSET_MANAGE];
        await request(assetServer())
          .get('/api/v1/assets/asset-1/download')
          .set(assetAuth())
          .expect(403);
        expect(storage.get).not.toHaveBeenCalled();
      });

      it('denies a branch asset outside the caller branch grants', async () => {
        model('asset').findFirst = vi.fn(async () => storedAsset('branch-2'));
        model('userBranchAccess').findFirst = vi.fn(async () => null);
        const response = await request(assetServer())
          .get('/api/v1/assets/asset-1/download')
          .set(assetAuth())
          .expect(403);
        expect(response.body.message).toBe('Branch access denied');
        expect(storage.get).not.toHaveBeenCalled();
      });

      it('reports a deleted or unknown asset as not found', async () => {
        model('asset').findFirst = vi.fn(async () => null);
        const response = await request(assetServer())
          .get('/api/v1/assets/asset-1/download')
          .set(assetAuth())
          .expect(404);
        expect(response.body.message).toBe('Asset not found');
        expect(storage.get).not.toHaveBeenCalled();
      });
    });

    describe('usage (GET /assets/:assetId/usage)', () => {
      // Only reads are mocked on the strict client: a transaction, row lock,
      // write, or audit insert would hit an unmocked member and fail with 500.
      type StoredRevision = {
        organizationId: string;
        branchId: string;
        revisionId: string;
        values: Record<string, unknown>;
      };
      let revisions: StoredRevision[];
      const usage = (assetId = 'asset-1') =>
        request(assetServer())
          .get(`/api/v1/assets/${assetId}/usage`)
          .set(assetAuth());

      beforeEach(() => {
        grantedPermissions = [
          PERMISSIONS.ASSET_READ,
          PERMISSIONS.BRANCH_MANAGE,
        ];
        storage.get.mockReset();
        storage.put.mockReset();
        storage.remove.mockReset();
        revisions = [];
        prismaRoot.$queryRaw = vi.fn(
          async (_sql: TemplateStringsArray, ...parameters: unknown[]) => {
            const [organizationId, assetId] = parameters;
            return revisions
              .filter(
                (item) =>
                  item.organizationId === organizationId &&
                  Object.values(item.values).includes(assetId),
              )
              .map((item) => ({
                revisionId: item.revisionId,
                revisionNumber: Number(item.revisionId.split('-')[1]),
                templateVersionId: 'version-1',
                creativeId: 'creative-1',
                creativeName: 'Spring Sale',
                branchId: item.branchId,
                branchName: item.branchId === 'branch-1' ? 'North' : 'South',
                isCurrentRevision: item.revisionId === 'revision-2',
                fieldKeys: Object.keys(item.values).filter(
                  (key) => item.values[key] === assetId,
                ),
              }));
          },
        );
        model('brandProfile').findFirst = vi.fn(async () => null);
        model('branchBrandOverride').findMany = vi.fn(async () => []);
        model('templateField').findMany = vi.fn(async () => [
          { versionId: 'version-1', key: 'logo', label: 'Logo', type: 'LOGO' },
        ]);
      });

      it('returns grouped references for an asset in use', async () => {
        revisions = [
          {
            organizationId: 'org-1',
            branchId: 'branch-1',
            revisionId: 'revision-2',
            values: { logo: 'asset-1' },
          },
          {
            organizationId: 'org-1',
            branchId: 'branch-1',
            revisionId: 'revision-1',
            values: { logo: 'asset-1' },
          },
          {
            organizationId: 'org-2',
            branchId: 'branch-x',
            revisionId: 'revision-9',
            values: { logo: 'asset-1' },
          },
        ];
        model('brandProfile').findFirst = vi.fn(async () => ({
          id: 'profile-1',
          displayName: 'AdFlow',
        }));
        model('branchBrandOverride').findMany = vi.fn(async () => [
          { branchId: 'branch-1', branch: { name: 'North', code: 'NORTH' } },
        ]);
        const response = await usage().expect(200);
        expect(response.body).toEqual({
          assetId: 'asset-1',
          inUse: true,
          creativeRevisions: [
            {
              creativeId: 'creative-1',
              creativeName: 'Spring Sale',
              branchId: 'branch-1',
              branchName: 'North',
              revisionId: 'revision-2',
              revisionNumber: 2,
              isCurrentRevision: true,
              fields: [{ key: 'logo', label: 'Logo', type: 'LOGO' }],
            },
            {
              creativeId: 'creative-1',
              creativeName: 'Spring Sale',
              branchId: 'branch-1',
              branchName: 'North',
              revisionId: 'revision-1',
              revisionNumber: 1,
              isCurrentRevision: false,
              fields: [{ key: 'logo', label: 'Logo', type: 'LOGO' }],
            },
          ],
          organizationBrandProfile: {
            profileId: 'profile-1',
            displayName: 'AdFlow',
          },
          branchBrandProfiles: [
            { branchId: 'branch-1', branchName: 'North', branchCode: 'NORTH' },
          ],
          hiddenReferenceCount: 0,
        });
        // The other organization's revision is filtered by the query itself.
        expect(JSON.stringify(response.body)).not.toContain('revision-9');
        expect(
          (prismaRoot.$queryRaw as MockFn).mock.calls[0]?.slice(1),
        ).toEqual(['org-1', 'asset-1']);
        expect(model('brandProfile').findFirst).toHaveBeenCalledWith({
          where: { logoAssetId: 'asset-1', organizationId: 'org-1' },
          select: { id: true, displayName: true },
        });
        expect(model('branchBrandOverride').findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              logoAssetId: 'asset-1',
              branch: { organizationId: 'org-1' },
            },
          }),
        );
      });

      it('reports an unused asset', async () => {
        const response = await usage().expect(200);
        expect(response.body).toEqual({
          assetId: 'asset-1',
          inUse: false,
          creativeRevisions: [],
          organizationBrandProfile: null,
          branchBrandProfiles: [],
          hiddenReferenceCount: 0,
        });
      });

      it('hides details from branches the caller has no grant to, but still reports use', async () => {
        grantedPermissions = [PERMISSIONS.ASSET_READ];
        model('userBranchAccess').findMany = vi.fn(async () => [
          { branchId: 'branch-1' },
        ]);
        revisions = [
          {
            organizationId: 'org-1',
            branchId: 'branch-2',
            revisionId: 'revision-1',
            values: { logo: 'asset-1' },
          },
        ];
        const response = await usage().expect(200);
        expect(response.body).toMatchObject({
          inUse: true,
          creativeRevisions: [],
          hiddenReferenceCount: 1,
        });
        expect(JSON.stringify(response.body)).not.toMatch(/South|branch-2/);
      });

      it('returns 404 for an unknown or deleted asset', async () => {
        model('asset').findFirst = vi.fn(async () => null);
        const response = await usage('asset-missing').expect(404);
        expect(response.body.message).toBe('Asset not found');
        expect(prismaRoot.$queryRaw).not.toHaveBeenCalled();
      });

      it('denies callers without read permission or branch access', async () => {
        grantedPermissions = [];
        await usage().expect(403);
        grantedPermissions = [PERMISSIONS.ASSET_READ];
        model('asset').findFirst = vi.fn(async () => storedAsset('branch-2'));
        model('userBranchAccess').findFirst = vi.fn(async () => null);
        const response = await usage().expect(403);
        expect(response.body.message).toBe('Branch access denied');
        expect(prismaRoot.$queryRaw).not.toHaveBeenCalled();
      });

      it('requires authentication', async () => {
        await request(assetServer())
          .get('/api/v1/assets/asset-1/usage')
          .expect(401);
      });

      it('writes nothing: no transaction, audit event, or storage access', async () => {
        revisions = [
          {
            organizationId: 'org-1',
            branchId: 'branch-1',
            revisionId: 'revision-2',
            values: { logo: 'asset-1' },
          },
        ];
        await usage().expect(200);
        // None of these are mocked on the strict client; any access would
        // have failed the request.
        expect('$transaction' in prismaRoot).toBe(false);
        expect(models.has('auditLog')).toBe(false);
        expect(storage.get).not.toHaveBeenCalled();
        expect(storage.put).not.toHaveBeenCalled();
        expect(storage.remove).not.toHaveBeenCalled();
      });
    });

    describe('deletion and branch moves', () => {
      // References as stored, each tagged with the organization it belongs
      // to. The fakes apply the real queries' filters: the caller's
      // organization, and the asset ID as a top-level revision value or as a
      // brand-profile or branch-override logo. Only the row lock, the
      // reference checks and the deletion writes are mocked, so any other
      // database access fails the request.
      type References = {
        revisions?: Array<{
          id: string;
          organizationId: string;
          values: Record<string, unknown>;
        }>;
        organizationLogos?: Array<{
          organizationId: string;
          logoAssetId: string;
        }>;
        branchLogos?: Array<{ organizationId: string; logoAssetId: string }>;
        // The branch the row lock finds (the stored asset's by default);
        // differs when a concurrent move committed after authorization.
        lockedBranchId?: string | null;
      };
      let transaction: Record<string, unknown> & {
        $queryRaw: MockFn;
        brandProfile: { findFirst: MockFn };
        branchBrandOverride: { findFirst: MockFn };
        asset: { update: MockFn };
        auditLog: { create: MockFn };
      };

      function withReferences(references: References = {}) {
        const logoFinder =
          (
            logos: References['organizationLogos'],
            organizationOf: (where: Record<string, unknown>) => unknown,
          ) =>
          async ({ where }: { where: Record<string, unknown> }) =>
            (logos ?? []).some(
              (logo) =>
                logo.logoAssetId === where.logoAssetId &&
                logo.organizationId === organizationOf(where),
            )
              ? { id: 'profile' }
              : null;
        transaction = {
          $queryRaw: vi.fn(
            async (sql: TemplateStringsArray, ...parameters: unknown[]) => {
              if (sql.join('?').includes('FOR UPDATE'))
                return [{ branchId: references.lockedBranchId ?? null }];
              const [organizationId, assetId] = parameters;
              return (references.revisions ?? [])
                .filter(
                  (revision) =>
                    revision.organizationId === organizationId &&
                    Object.values(revision.values).includes(assetId),
                )
                .slice(0, 1)
                .map((revision) => ({ id: revision.id }));
            },
          ),
          brandProfile: {
            findFirst: vi.fn(
              logoFinder(
                references.organizationLogos,
                (where) => where.organizationId,
              ),
            ),
          },
          branchBrandOverride: {
            findFirst: vi.fn(
              logoFinder(
                references.branchLogos,
                (where) =>
                  (where.branch as { organizationId: string }).organizationId,
              ),
            ),
          },
          asset: {
            update: vi.fn(
              async ({ data }: { data: Record<string, unknown> }) => ({
                id: 'asset-1',
                ...data,
              }),
            ),
          },
          auditLog: { create: vi.fn(async () => ({})) },
        };
        const client = strict('tx', transaction);
        prismaRoot.$transaction = vi.fn(
          async (work: (tx: typeof client) => Promise<unknown>) => work(client),
        );
      }

      const deleteAsset = () =>
        request(assetServer())
          .delete('/api/v1/assets/asset-1')
          .set(assetAuth());
      const expectNothingWritten = () => {
        expect(transaction.asset.update).not.toHaveBeenCalled();
        expect(transaction.auditLog.create).not.toHaveBeenCalled();
        expect(storage.remove).not.toHaveBeenCalled();
      };

      beforeEach(() => {
        grantedPermissions = [
          PERMISSIONS.ASSET_READ,
          PERMISSIONS.ASSET_MANAGE,
          PERMISSIONS.ORGANIZATION_UPDATE,
        ];
        storage.remove.mockReset();
        storage.remove.mockResolvedValue(undefined);
      });

      it('returns 409 without writes or file removal for a referenced asset', async () => {
        withReferences({
          revisions: [
            {
              id: 'revision-1',
              organizationId: 'org-1',
              values: { headline: 'Sale', logo: 'asset-1' },
            },
          ],
        });
        const response = await deleteAsset().expect(409);
        expect(response.body.message).toBe(
          'Asset is used by a creative revision and cannot be deleted',
        );
        expect(response.body).toMatchObject({
          statusCode: 409,
          error: 'Conflict',
          reason: 'CREATIVE_REVISION',
        });
        expect(JSON.stringify(response.body)).not.toContain('revision-1');
        expectNothingWritten();
      });

      it('returns 409 for the organization brand logo', async () => {
        withReferences({
          organizationLogos: [
            { organizationId: 'org-1', logoAssetId: 'asset-1' },
          ],
        });
        const response = await deleteAsset().expect(409);
        expect(response.body.message).toBe(
          'Asset is used as the organization brand logo and cannot be deleted',
        );
        expect(response.body.reason).toBe('ORGANIZATION_BRAND_LOGO');
        expectNothingWritten();
      });

      it('returns 409 for a branch brand logo', async () => {
        withReferences({
          branchLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
        });
        const response = await deleteAsset().expect(409);
        expect(response.body.message).toBe(
          'Asset is used as a branch brand logo and cannot be deleted',
        );
        expect(response.body.reason).toBe('BRANCH_BRAND_LOGO');
        expectNothingWritten();
      });

      it('deletes an unreferenced asset and its stored file', async () => {
        withReferences({
          revisions: [
            {
              id: 'revision-1',
              organizationId: 'org-1',
              values: { logo: 'asset-2' },
            },
          ],
          organizationLogos: [
            { organizationId: 'org-1', logoAssetId: 'asset-2' },
          ],
        });
        const response = await deleteAsset().expect(200);
        expect(response.body).toEqual({ id: 'asset-1', status: 'DELETED' });
        expect(transaction.asset.update).toHaveBeenCalledWith({
          where: { id: 'asset-1' },
          data: { status: 'DELETED', deletedAt: expect.any(Date) },
        });
        expect(transaction.auditLog.create).toHaveBeenCalledTimes(1);
        expect(storage.remove).toHaveBeenCalledWith('generated.png');
      });

      it('ignores references and logos from another organization', async () => {
        withReferences({
          revisions: [
            {
              id: 'revision-x',
              organizationId: 'org-2',
              values: { logo: 'asset-1' },
            },
          ],
          organizationLogos: [
            { organizationId: 'org-2', logoAssetId: 'asset-1' },
          ],
          branchLogos: [{ organizationId: 'org-2', logoAssetId: 'asset-1' }],
        });
        await deleteAsset().expect(200);
        expect(transaction.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
          'asset-1',
          'org-1',
        ]);
        expect(transaction.$queryRaw.mock.calls[1]?.slice(1)).toEqual([
          'org-1',
          'asset-1',
        ]);
        expect(storage.remove).toHaveBeenCalledWith('generated.png');
      });

      it('returns 404 without writes when a concurrent deletion won the row lock', async () => {
        withReferences();
        transaction.$queryRaw.mockImplementationOnce(async () => []);
        const response = await deleteAsset().expect(404);
        expect(response.body.message).toBe('Asset not found');
        expectNothingWritten();
      });

      describe('branch move (PATCH branchId)', () => {
        // branch-1 and branch-2 belong to org-1; anything else does not.
        const organizationBranches = new Set(['branch-1', 'branch-2']);
        const moveAsset = (branchId: string | null) =>
          request(assetServer())
            .patch('/api/v1/assets/asset-1')
            .set(assetAuth())
            .send({ branchId });
        const expectUnchanged = () => {
          expect(transaction.asset.update).not.toHaveBeenCalled();
          expect(transaction.auditLog.create).not.toHaveBeenCalled();
          expect(storage.put).not.toHaveBeenCalled();
          expect(storage.remove).not.toHaveBeenCalled();
        };

        beforeEach(() => {
          grantedPermissions = [
            PERMISSIONS.ASSET_READ,
            PERMISSIONS.ASSET_MANAGE,
            PERMISSIONS.BRANCH_MANAGE,
            PERMISSIONS.ORGANIZATION_UPDATE,
          ];
          storage.put.mockReset();
          model('asset').findFirst = vi.fn(async () => storedAsset('branch-1'));
          model('branch').findFirst = vi.fn(
            async ({
              where,
            }: {
              where: { id: string; organizationId: string };
            }) =>
              where.organizationId === 'org-1' &&
              organizationBranches.has(where.id)
                ? { id: where.id }
                : null,
          );
        });

        it('returns 409 CREATIVE_REVISION and keeps the branch for a referenced asset', async () => {
          withReferences({
            lockedBranchId: 'branch-1',
            revisions: [
              {
                id: 'revision-1',
                organizationId: 'org-1',
                values: { logo: 'asset-1' },
              },
            ],
          });
          const response = await moveAsset('branch-2').expect(409);
          expect(response.body).toEqual({
            statusCode: 409,
            error: 'Conflict',
            reason: 'CREATIVE_REVISION',
            message:
              'Asset is used by a creative revision and cannot be moved to another branch',
          });
          expectUnchanged();
        });

        it('returns 409 ORGANIZATION_BRAND_LOGO for the organization logo', async () => {
          model('asset').findFirst = vi.fn(async () => storedAsset(null));
          withReferences({
            lockedBranchId: null,
            organizationLogos: [
              { organizationId: 'org-1', logoAssetId: 'asset-1' },
            ],
          });
          const response = await moveAsset('branch-2').expect(409);
          expect(response.body.reason).toBe('ORGANIZATION_BRAND_LOGO');
          expect(response.body.message).toBe(
            'Asset is used as the organization brand logo and cannot be moved to another branch',
          );
          expectUnchanged();
        });

        it('returns 409 BRANCH_BRAND_LOGO for a branch logo', async () => {
          withReferences({
            lockedBranchId: 'branch-1',
            branchLogos: [{ organizationId: 'org-1', logoAssetId: 'asset-1' }],
          });
          const response = await moveAsset('branch-2').expect(409);
          expect(response.body.reason).toBe('BRANCH_BRAND_LOGO');
          expectUnchanged();
        });

        it('moves an unreferenced asset', async () => {
          withReferences({
            lockedBranchId: 'branch-1',
            revisions: [
              {
                id: 'revision-1',
                organizationId: 'org-1',
                values: { logo: 'asset-2' },
              },
            ],
          });
          const response = await moveAsset('branch-2').expect(200);
          expect(response.body).toMatchObject({
            id: 'asset-1',
            branchId: 'branch-2',
          });
          expect(transaction.asset.update).toHaveBeenCalledWith(
            expect.objectContaining({
              where: { id: 'asset-1' },
              data: { branchId: 'branch-2' },
            }),
          );
          expect(transaction.auditLog.create).toHaveBeenCalledTimes(1);
          expect(storage.put).not.toHaveBeenCalled();
          expect(storage.remove).not.toHaveBeenCalled();
        });

        it('ignores references and logos from another organization', async () => {
          withReferences({
            lockedBranchId: 'branch-1',
            revisions: [
              {
                id: 'revision-x',
                organizationId: 'org-2',
                values: { logo: 'asset-1' },
              },
            ],
            organizationLogos: [
              { organizationId: 'org-2', logoAssetId: 'asset-1' },
            ],
            branchLogos: [{ organizationId: 'org-2', logoAssetId: 'asset-1' }],
          });
          await moveAsset('branch-2').expect(200);
          expect(transaction.$queryRaw.mock.calls[0]?.slice(1)).toEqual([
            'asset-1',
            'org-1',
          ]);
          expect(transaction.$queryRaw.mock.calls[1]?.slice(1)).toEqual([
            'org-1',
            'asset-1',
          ]);
        });

        it('returns a retryable 409 when a concurrent move changed the branch first', async () => {
          withReferences({ lockedBranchId: 'branch-2' });
          const response = await moveAsset(null).expect(409);
          expect(response.body.message).toBe(transactionConflictMessage);
          expectUnchanged();
        });

        it('returns 404 when the asset was deleted before the lock', async () => {
          withReferences();
          transaction.$queryRaw.mockImplementationOnce(async () => []);
          const response = await moveAsset('branch-2').expect(404);
          expect(response.body.message).toBe('Asset not found');
          expectUnchanged();
        });

        it('keeps permission and branch isolation checks ahead of any lock', async () => {
          withReferences({ lockedBranchId: 'branch-1' });
          // No asset-management permission: refused by the guard.
          grantedPermissions = [PERMISSIONS.ASSET_READ];
          await moveAsset('branch-2').expect(403);
          // Branch to branch without branch management.
          grantedPermissions = [
            PERMISSIONS.ASSET_READ,
            PERMISSIONS.ASSET_MANAGE,
            PERMISSIONS.ORGANIZATION_UPDATE,
          ];
          model('userBranchAccess').findFirst = vi.fn(async () => ({
            branchId: 'branch-1',
          }));
          const scope = await moveAsset('branch-2').expect(403);
          expect(scope.body.message).toBe('Asset scope cannot be changed');
          // A target branch outside the organization.
          grantedPermissions = [
            PERMISSIONS.ASSET_READ,
            PERMISSIONS.ASSET_MANAGE,
            PERMISSIONS.BRANCH_MANAGE,
          ];
          const foreign = await moveAsset('branch-foreign').expect(403);
          expect(foreign.body.message).toBe('Branch access denied');
          // An asset in a branch the caller has no grant to.
          grantedPermissions = [
            PERMISSIONS.ASSET_READ,
            PERMISSIONS.ASSET_MANAGE,
          ];
          model('asset').findFirst = vi.fn(async () => storedAsset('branch-2'));
          model('userBranchAccess').findFirst = vi.fn(async () => null);
          const hidden = await moveAsset('branch-1').expect(403);
          expect(hidden.body.message).toBe('Branch access denied');
          expect(prismaRoot.$transaction).not.toHaveBeenCalled();
          expect(transaction.$queryRaw).not.toHaveBeenCalled();
        });

        it('rejects an invalid branch value before any database work', async () => {
          withReferences();
          await request(assetServer())
            .patch('/api/v1/assets/asset-1')
            .set(assetAuth())
            .send({ branchId: '' })
            .expect(400);
          expect(transaction.$queryRaw).not.toHaveBeenCalled();
        });
      });
    });

    describe('brand logo updates', () => {
      let transaction: Record<string, unknown> & {
        $queryRaw: MockFn;
        brandProfile: { upsert: MockFn };
        auditLog: { create: MockFn };
      };

      beforeEach(() => {
        grantedPermissions = [
          PERMISSIONS.BRAND_MANAGE,
          PERMISSIONS.ORGANIZATION_UPDATE,
        ];
        transaction = {
          $queryRaw: vi.fn(async () => [{ id: 'asset-1' }]),
          brandProfile: { upsert: vi.fn(async () => ({ id: 'profile-1' })) },
          auditLog: { create: vi.fn(async () => ({})) },
        };
        const client = strict('tx', transaction);
        prismaRoot.$transaction = vi.fn(
          async (work: (tx: typeof client) => Promise<unknown>) => work(client),
        );
      });

      it('locks the logo in the profile transaction before saving it', async () => {
        await request(assetServer())
          .patch('/api/v1/organization/brand')
          .set(assetAuth())
          .send({ logoAssetId: 'asset-1' })
          .expect(200);
        const [sql, ...parameters] = transaction.$queryRaw.mock.calls[0] ?? [];
        expect((sql as TemplateStringsArray).join('?')).toMatch(
          /FOR SHARE\s*$/,
        );
        expect(parameters).toEqual(
          expect.arrayContaining([expect.anything(), 'org-1']),
        );
        expect(transaction.brandProfile.upsert).toHaveBeenCalled();
      });

      it('returns 404 without saving when the logo was deleted concurrently', async () => {
        transaction.$queryRaw.mockImplementationOnce(async () => []);
        const response = await request(assetServer())
          .patch('/api/v1/organization/brand')
          .set(assetAuth())
          .send({ logoAssetId: 'asset-1' })
          .expect(404);
        expect(response.body.message).toBe('Asset not found');
        expect(transaction.brandProfile.upsert).not.toHaveBeenCalled();
        expect(transaction.auditLog.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('transaction contention', () => {
    beforeEach(() => {
      grantedPermissions = [PERMISSIONS.TEMPLATE_ARCHIVE];
      model('template').findFirst = vi.fn(async () => ({
        id: 'template-1',
        organizationId: 'org-1',
        status: 'ACTIVE',
      }));
    });

    const contention = (code: string) =>
      new Prisma.PrismaClientKnownRequestError(`${code} from the database`, {
        code,
        clientVersion: 'test',
      });

    it('returns 409 for a rolled-back P2034 conflict', async () => {
      prismaRoot.$transaction = vi.fn(async () => {
        throw contention('P2034');
      });
      const response = await request(server())
        .post('/api/v1/templates/template-1/archive')
        .set(auth())
        .expect(409);
      expect(response.body.message).toBe(transactionConflictMessage);
    });

    it('returns 503 for an unconfirmed P2028 outcome', async () => {
      prismaRoot.$transaction = vi.fn(async () => {
        throw contention('P2028');
      });
      const response = await request(server())
        .post('/api/v1/templates/template-1/archive')
        .set(auth())
        .expect(503);
      expect(response.body.message).toBe(transactionUnconfirmedMessage);
      expect(JSON.stringify(response.body)).not.toContain('from the database');
    });

    it('still returns 500 for an unrelated Prisma error', async () => {
      prismaRoot.$transaction = vi.fn(async () => {
        throw contention('P2025');
      });
      await request(server())
        .post('/api/v1/templates/template-1/archive')
        .set(auth())
        .expect(500);
    });

    const rawQueryFailure = (sqlState: string) =>
      new Prisma.PrismaClientKnownRequestError('Raw query failed', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: sqlState, message: `ERROR: deadlock detected` },
      });

    it('returns 409 for a deadlock raised inside a raw query (P2010, 40P01)', async () => {
      prismaRoot.$transaction = vi.fn(async () => {
        throw rawQueryFailure('40P01');
      });
      const response = await request(server())
        .post('/api/v1/templates/template-1/archive')
        .set(auth())
        .expect(409);
      expect(response.body.message).toBe(transactionConflictMessage);
      expect(JSON.stringify(response.body)).not.toMatch(/40P01|deadlock/i);
    });

    it('still returns 500 for an unrelated raw-query failure', async () => {
      prismaRoot.$transaction = vi.fn(async () => {
        throw rawQueryFailure('42P01');
      });
      await request(server())
        .post('/api/v1/templates/template-1/archive')
        .set(auth())
        .expect(500);
    });
  });
});

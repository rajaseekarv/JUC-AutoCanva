import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
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

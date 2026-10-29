import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MockCanvaProvider } from './mock-canva.provider';
import { CanvaService } from './canva.service';
import {
  MemoryCanvaDatabase,
  MemoryCredentialStore,
  testRealConfig,
} from './oauth/canva-oauth.test-doubles';
import type { CanvaAccessTokenService } from './oauth/canva-access-token.service';
import type { CanvaRevocationWorker } from './oauth/canva-revocation.worker';
import { CanvaWriteOutcomeUnknownError } from './oauth/canva-oauth.stores';

const principal: AuthenticatedPrincipal = {
  id: 'user-1',
  sessionId: 'session-1',
  organizationId: 'org-1',
  name: 'Branch Operator',
  email: 'operator@example.local',
  permissions: [
    PERMISSIONS.CANVA_INTEGRATION_READ,
    PERMISSIONS.CANVA_JOB_CREATE,
  ],
  branches: [{ id: 'branch-1', name: 'North', code: 'NORTH' }],
};

function makeService(options?: {
  branchAllowed?: boolean;
  existingJob?: Record<string, unknown> | null;
  provider?: MockCanvaProvider;
}) {
  const job = {
    id: 'job-1',
    organizationId: 'org-1',
    branchId: 'branch-1',
    creativeId: 'creative-1',
    creativeRevisionId: 'revision-1',
    idempotencyKey: 'idem-key-0001',
    status: 'QUEUED',
    mode: 'MOCK',
    externalDesignId: null,
    errorCode: null,
    errorMessage: null,
  };
  // Simulates the conditional QUEUED transition against one persisted row.
  let persisted: Record<string, unknown> = {
    ...job,
    ...(options?.existingJob ?? {}),
  };
  const txUpdate = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => {
      if (persisted.id !== where.id || persisted.status !== where.status)
        return { count: 0 };
      persisted = { ...persisted, ...data };
      return { count: 1 };
    },
  );
  const txFindUniqueOrThrow = vi.fn(async () => persisted);
  const auditWrite = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    branch: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
    userBranchAccess: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          options?.branchAllowed === false ? null : { branchId: 'branch-1' },
        ),
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
    },
    canvaConnection: {
      findUnique: vi.fn().mockResolvedValue({ status: 'CONNECTED' }),
      upsert: vi.fn(),
    },
    canvaJob: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(options?.existingJob ?? null),
      create: vi.fn().mockResolvedValue(job),
    },
    creative: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'creative-1',
        organizationId: 'org-1',
        branchId: 'branch-1',
        currentRevision: {
          id: 'revision-1',
          revisionNumber: 1,
          templateVersionId: 'template-version-1',
          templateVersion: {
            name: 'Social square',
            template: { id: 'template-1' },
          },
        },
      }),
    },
    creativeRevision: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'revision-1',
        creativeId: 'creative-1',
        revisionNumber: 1,
        templateVersionId: 'template-version-1',
        templateVersion: { name: 'Social square' },
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        canvaConnection: { upsert: vi.fn() },
        canvaJob: {
          updateMany: txUpdate,
          findUniqueOrThrow: txFindUniqueOrThrow,
        },
        auditLog: {},
      }),
    ),
  } as unknown as PrismaService;
  const audit = { write: auditWrite } as unknown as AuditService;
  const provider = options?.provider ?? new MockCanvaProvider();
  return {
    service: new CanvaService(prisma, audit, provider),
    prisma,
    provider,
    auditWrite,
    txUpdate,
    persisted: () => persisted,
  };
}

const queuedJob = {
  id: 'job-1',
  organizationId: 'org-1',
  branchId: 'branch-1',
  creativeId: 'creative-1',
  creativeRevisionId: 'revision-1',
  idempotencyKey: 'idem-key-0001',
  status: 'QUEUED',
  mode: 'MOCK',
};

describe('CanvaService', () => {
  it('rejects organization integration reads without permission', async () => {
    const { service } = makeService();
    await expect(
      service.status({ ...principal, permissions: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('runs safely with no Canva OAuth configuration in mock mode', async () => {
    const { service, prisma } = makeService();
    vi.mocked(prisma.canvaConnection.findUnique).mockResolvedValueOnce(
      null as never,
    );
    await expect(service.status(principal)).resolves.toMatchObject({
      provider: 'CANVA',
      mode: 'MOCK',
      status: 'DISCONNECTED',
      isRealConnection: false,
    });
  });

  it('rejects job creation without the job permission', async () => {
    const { service, prisma } = makeService();
    await expect(
      service.createJob(
        { ...principal, permissions: [PERMISSIONS.CANVA_INTEGRATION_READ] },
        'creative-1',
        'idem-key-0001',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.creative.findFirst).not.toHaveBeenCalled();
  });

  it('does not create a job when the user lacks current branch access', async () => {
    const { service, prisma } = makeService({ branchAllowed: false });
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.canvaJob.create).not.toHaveBeenCalled();
  });

  it('lists jobs only for the user organization and current branch grants', async () => {
    const { service, prisma } = makeService();
    await service.listJobs(principal);
    expect(prisma.canvaJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          branchId: { in: ['branch-1'] },
        },
      }),
    );
  });

  it('creates a deterministic mock job and audits the authorized revision', async () => {
    const { service, prisma, auditWrite, txUpdate } = makeService();
    const result = await service.createJob(
      principal,
      'creative-1',
      'idem-key-0001',
    );
    expect(prisma.creative.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'creative-1', organizationId: 'org-1' },
      }),
    );
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'QUEUED' },
      data: {
        status: 'SUCCEEDED',
        externalDesignId: 'mock-design-revision-1',
      },
    });
    expect(result).toMatchObject({ status: 'SUCCEEDED', mode: 'MOCK' });
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: 'org-1',
        branchId: 'branch-1',
        creativeRevisionId: 'revision-1',
        action: 'canva.design.prepared',
      }),
    );
  });

  it('returns the same job for an idempotent retry without creating a second job', async () => {
    const existing = {
      id: 'existing-job',
      creativeId: 'creative-1',
      status: 'SUCCEEDED',
    };
    const { service, prisma } = makeService({ existingJob: existing });
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).resolves.toMatchObject({ id: 'existing-job', creativeId: 'creative-1' });
    expect(prisma.canvaJob.create).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different creative', async () => {
    const { service } = makeService({
      existingJob: {
        id: 'existing-job',
        creativeId: 'another-creative',
        status: 'SUCCEEDED',
      },
    });
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('stores a safe failure status instead of exposing provider exception details', async () => {
    const provider = new MockCanvaProvider();
    vi.spyOn(provider, 'prepareDesign').mockRejectedValue(
      new Error('credential=private provider failure'),
    );
    const { service, txUpdate } = makeService({ provider });
    const result = await service.createJob(
      principal,
      'creative-1',
      'idem-key-0001',
    );
    expect(txUpdate).toHaveBeenCalledWith({
      where: { id: 'job-1', status: 'QUEUED' },
      data: {
        status: 'FAILED',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'The provider could not prepare a design.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('returns 503 and leaves the job QUEUED when the success outcome cannot be saved', async () => {
    const { service, prisma, auditWrite, txUpdate, persisted } = makeService();
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(
      new Error('connection lost'),
    );
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(txUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
    expect(auditWrite).not.toHaveBeenCalled();
    expect(persisted().status).toBe('QUEUED');
  });

  it('resumes a QUEUED job on a same-key retry without creating a second job', async () => {
    const { service, prisma, auditWrite } = makeService({
      existingJob: queuedJob,
    });
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).resolves.toMatchObject({
      id: 'job-1',
      status: 'SUCCEEDED',
      externalDesignId: 'mock-design-revision-1',
    });
    expect(prisma.canvaJob.create).not.toHaveBeenCalled();
    expect(auditWrite).toHaveBeenCalledTimes(1);
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'canva.design.prepared',
        entityId: 'job-1',
      }),
    );
  });

  it('resumes against the revision stored on the job, not a newer current revision', async () => {
    const provider = new MockCanvaProvider();
    const prepareDesign = vi.spyOn(provider, 'prepareDesign');
    const { service, prisma, auditWrite } = makeService({
      existingJob: queuedJob,
      provider,
    });
    vi.mocked(prisma.creative.findFirst).mockResolvedValueOnce({
      id: 'creative-1',
      organizationId: 'org-1',
      branchId: 'branch-1',
      currentRevision: {
        id: 'revision-2',
        revisionNumber: 2,
        templateVersionId: 'template-version-2',
        templateVersion: { name: 'Social square v2' },
      },
    } as never);
    await service.createJob(principal, 'creative-1', 'idem-key-0001');
    expect(prisma.creativeRevision.findFirst).toHaveBeenCalledWith({
      where: { id: 'revision-1', creativeId: 'creative-1' },
      include: { templateVersion: true },
    });
    expect(prepareDesign).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: 'revision-1', revisionNumber: 1 }),
    );
    expect(auditWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ creativeRevisionId: 'revision-1' }),
    );
  });

  it('does not write a second audit event when another request already finalized the job', async () => {
    const { service, auditWrite, txUpdate, persisted } = makeService({
      existingJob: queuedJob,
    });
    // A concurrent retry wins the QUEUED transition first.
    txUpdate.mockImplementationOnce(async () => {
      Object.assign(persisted(), {
        status: 'SUCCEEDED',
        externalDesignId: 'mock-design-revision-1',
      });
      return { count: 0 };
    });
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).resolves.toMatchObject({ id: 'job-1', status: 'SUCCEEDED' });
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('keeps the job recoverable when a provider failure cannot be saved as FAILED', async () => {
    const provider = new MockCanvaProvider();
    vi.spyOn(provider, 'prepareDesign').mockRejectedValueOnce(
      new Error('provider down'),
    );
    const { service, prisma, auditWrite, persisted } = makeService({
      provider,
    });
    vi.mocked(prisma.$transaction).mockRejectedValueOnce(
      new Error('connection lost'),
    );
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(persisted().status).toBe('QUEUED');
    expect(auditWrite).not.toHaveBeenCalled();

    vi.mocked(prisma.canvaJob.findUnique).mockResolvedValueOnce(
      persisted() as never,
    );
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).resolves.toMatchObject({ id: 'job-1', status: 'SUCCEEDED' });
    expect(prisma.canvaJob.create).toHaveBeenCalledTimes(1);
    expect(auditWrite).toHaveBeenCalledTimes(1);
  });

  it('keeps a FAILED job final for its idempotency key', async () => {
    const provider = new MockCanvaProvider();
    const prepareDesign = vi.spyOn(provider, 'prepareDesign');
    const { service, prisma } = makeService({
      existingJob: { ...queuedJob, status: 'FAILED' },
      provider,
    });
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).resolves.toMatchObject({ id: 'job-1', status: 'FAILED' });
    expect(prepareDesign).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('CanvaService in real Canva mode', () => {
  // The design provider is still the mock; real mode must not let mock
  // connections or mock jobs pass as real Canva results.
  function realModeService() {
    const base = makeService();
    const audit = { write: base.auditWrite } as unknown as AuditService;
    return {
      ...base,
      service: new CanvaService(
        base.prisma,
        audit,
        base.provider,
        testRealConfig(),
      ),
    };
  }

  it('refuses the mock connect and disconnect actions with 409 and writes nothing', async () => {
    const { service, prisma } = realModeService();
    const manager = {
      ...principal,
      permissions: [PERMISSIONS.CANVA_INTEGRATION_MANAGE],
    };
    await expect(service.connect(manager)).rejects.toThrow(
      new ConflictException(
        'In real Canva mode, connect through Canva authorization',
      ),
    );
    await expect(service.disconnect(manager)).rejects.toThrow(
      new ConflictException('Real Canva disconnection is not available yet'),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses mock job creation with a non-retryable 409 before any lookup', async () => {
    const { service, prisma } = realModeService();
    await expect(
      service.createJob(principal, 'creative-1', 'idem-key-0001'),
    ).rejects.toThrow(
      new ConflictException(
        'Real Canva design preparation is not available yet',
      ),
    );
    expect(prisma.creative.findFirst).not.toHaveBeenCalled();
  });

  it('reports real mode and ignores a leftover mock connection', async () => {
    const { service, prisma } = realModeService();
    vi.mocked(prisma.canvaConnection.findUnique).mockResolvedValueOnce({
      status: 'CONNECTED',
      mode: 'MOCK',
      connectedAt: new Date(),
    } as never);
    await expect(service.status(principal)).resolves.toMatchObject({
      mode: 'CANVA',
      status: 'DISCONNECTED',
      accountLabel: null,
      isRealConnection: false,
    });
  });

  it('keeps reporting a stored mock connection in mock mode', async () => {
    const { service, prisma } = makeService();
    vi.mocked(prisma.canvaConnection.findUnique).mockResolvedValueOnce({
      status: 'CONNECTED',
      mode: 'MOCK',
      connectedAt: new Date(),
    } as never);
    await expect(service.status(principal)).resolves.toMatchObject({
      mode: 'MOCK',
      status: 'CONNECTED',
      accountLabel: 'Mock Canva account',
      isRealConnection: false,
    });
  });
});

describe('CanvaService in real Canva mode with durable storage', () => {
  function persistentService() {
    const base = makeService();
    const audit = { write: base.auditWrite } as unknown as AuditService;
    const db = new MemoryCanvaDatabase();
    const credentials = new MemoryCredentialStore(db);
    const worker = { trigger: vi.fn() };
    const accessTokens = {
      disconnect: vi.fn(async () => ({
        removed: true,
        revocation: 'queued' as const,
      })),
    };
    return {
      ...base,
      db,
      worker,
      accessTokens,
      service: new CanvaService(
        base.prisma,
        audit,
        base.provider,
        testRealConfig({ persistence: true }),
        credentials,
        accessTokens as unknown as CanvaAccessTokenService,
        worker as unknown as CanvaRevocationWorker,
      ),
    };
  }

  const manager = {
    ...principal,
    permissions: [
      PERMISSIONS.CANVA_INTEGRATION_READ,
      PERMISSIONS.CANVA_INTEGRATION_MANAGE,
    ],
  };

  it('reports reauthorization, configuration, and revocation counts without Canva IDs', async () => {
    const { service, db, worker } = persistentService();
    Object.assign(db.connection('org-1'), {
      status: 'REAUTHORIZATION_REQUIRED',
      reauthorizationReason: 'invalid_grant',
      configurationError: true,
    });
    db.enqueue({
      organizationId: 'org-1',
      chainId: 'chain-1',
      canvaUserId: 'canva-secret-id',
      reason: 'disconnect',
      refreshToken: { keyVersion: 1, iv: 'a', ciphertext: 'b', tag: 'c' },
    });
    const status = await service.status(principal);
    expect(status).toMatchObject({
      mode: 'CANVA',
      status: 'DISCONNECTED',
      isRealConnection: false,
      canva: {
        reauthorizationRequired: true,
        reauthorizationReason: 'invalid_grant',
        configurationError: true,
        pendingRevocations: 1,
        exhaustedRevocations: 0,
      },
    });
    expect(JSON.stringify(status)).not.toContain('canva-secret-id');
    // Status reads drive queued revocations (when the worker is enabled).
    expect(worker.trigger).toHaveBeenCalled();
  });

  it('disconnects through the guarded store and reports the revocation as queued', async () => {
    const { service, accessTokens, prisma } = persistentService();
    await expect(service.disconnect(manager)).resolves.toMatchObject({
      mode: 'CANVA',
      status: 'DISCONNECTED',
      revocation: 'queued',
    });
    expect(accessTokens.disconnect).toHaveBeenCalledWith('org-1', 'user-1');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps an unconfirmed disconnection to 503', async () => {
    const { service, accessTokens } = persistentService();
    accessTokens.disconnect.mockRejectedValueOnce(
      new CanvaWriteOutcomeUnknownError(),
    );
    await expect(service.disconnect(manager)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('still requires the management permission', async () => {
    const { service, accessTokens } = persistentService();
    await expect(service.disconnect(principal)).rejects.toThrow(
      ForbiddenException,
    );
    expect(accessTokens.disconnect).not.toHaveBeenCalled();
  });
});

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CanvaConnectionStatus,
  CanvaJobStatus,
  Prisma,
  type CanvaJob,
} from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CANVA_PROVIDER,
  type CanvaProvider,
  type PreparedDesign,
} from './canva-provider';
import {
  CANVA_OAUTH_CONFIG,
  type CanvaOAuthConfig,
} from './oauth/canva-oauth.config';
import {
  CANVA_CREDENTIAL_STORE,
  CanvaPersistenceUnavailableError,
  CanvaWriteOutcomeUnknownError,
  isDefiniteWriteFailure,
  type CanvaConnectionDetails,
  type CanvaCredentialStore,
} from './oauth/canva-oauth.stores';
import { CanvaAccessTokenService } from './oauth/canva-access-token.service';
import { CanvaRevocationWorker } from './oauth/canva-revocation.worker';

@Injectable()
export class CanvaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CANVA_PROVIDER) private readonly provider: CanvaProvider,
    // Absent (as in unit tests) means mock mode, the default.
    @Optional()
    @Inject(CANVA_OAUTH_CONFIG)
    private readonly oauthConfig?: CanvaOAuthConfig,
    // Real mode only; absent in mock-mode unit tests.
    @Optional()
    @Inject(CANVA_CREDENTIAL_STORE)
    private readonly credentials?: CanvaCredentialStore,
    @Optional() private readonly accessTokens?: CanvaAccessTokenService,
    @Optional() private readonly worker?: CanvaRevocationWorker,
  ) {}

  // Real mode connects only through Canva OAuth. Mock connections and mock
  // jobs are refused there, so a mock result can never pass as a real one.
  private get realMode(): boolean {
    return this.oauthConfig?.mode === 'canva';
  }

  private refuseInRealMode(message: string): void {
    if (this.realMode) throw new ConflictException(message);
  }

  private require(user: AuthenticatedPrincipal, permission: string): void {
    if (!user.permissions.includes(permission))
      throw new ForbiddenException('Permission denied');
  }

  private publicJob(job: CanvaJob) {
    return {
      id: job.id,
      organizationId: job.organizationId,
      branchId: job.branchId,
      creativeId: job.creativeId,
      creativeRevisionId: job.creativeRevisionId,
      status: job.status,
      mode: job.mode,
      externalDesignId: job.externalDesignId,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private async assertBranch(
    user: AuthenticatedPrincipal,
    branchId: string,
  ): Promise<void> {
    const accessible = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? await this.prisma.branch.findFirst({
          where: {
            id: branchId,
            organizationId: user.organizationId,
            status: 'ACTIVE',
          },
          select: { id: true },
        })
      : await this.prisma.userBranchAccess.findFirst({
          where: {
            userId: user.id,
            branchId,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    if (!accessible) throw new NotFoundException('Creative not found');
  }

  async status(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.CANVA_INTEGRATION_READ);
    if (this.realMode && this.persistenceEnabled)
      return this.realStatus(user.organizationId);
    const connection = await this.prisma.canvaConnection.findUnique({
      where: { organizationId: user.organizationId },
      select: { status: true, mode: true, connectedAt: true },
    });
    const mode = this.realMode ? 'CANVA' : this.provider.mode;
    // A stored connection counts only in the mode that created it, so a
    // leftover mock connection never appears connected in real mode.
    const connected =
      connection?.status === CanvaConnectionStatus.CONNECTED &&
      (connection.mode ?? 'MOCK') === mode;
    return {
      provider: 'CANVA',
      mode,
      status: connected
        ? CanvaConnectionStatus.CONNECTED
        : CanvaConnectionStatus.DISCONNECTED,
      connectedAt: connection?.connectedAt ?? null,
      accountLabel: connected
        ? mode === 'MOCK'
          ? 'Mock Canva account'
          : 'Canva account connected'
        : null,
      isRealConnection: connected && mode === 'CANVA',
    };
  }

  private get persistenceEnabled(): boolean {
    return (
      this.oauthConfig?.mode === 'canva' &&
      this.oauthConfig.persistence &&
      !!this.credentials
    );
  }

  // Real mode with durable storage: the stored connection, plus what an
  // administrator needs to act on. Never includes Canva IDs or tokens.
  private async realStatus(organizationId: string) {
    let details: CanvaConnectionDetails | null;
    try {
      details = await this.credentials!.details(organizationId);
    } catch {
      throw new ServiceUnavailableException(
        'Canva connection status is temporarily unavailable',
      );
    }
    // Status reads also drive queued revocations (when the worker is on).
    if (details?.pendingRevocations) this.worker?.trigger();
    const connected =
      details?.status === CanvaConnectionStatus.CONNECTED &&
      details.mode === 'CANVA';
    return {
      provider: 'CANVA',
      mode: 'CANVA',
      status: connected
        ? CanvaConnectionStatus.CONNECTED
        : CanvaConnectionStatus.DISCONNECTED,
      connectedAt: connected ? details!.connectedAt : null,
      accountLabel: connected ? 'Canva account connected' : null,
      isRealConnection: connected,
      canva: {
        reauthorizationRequired: details?.status === 'REAUTHORIZATION_REQUIRED',
        reauthorizationReason: details?.reauthorizationReason ?? null,
        configurationError: details?.configurationError ?? false,
        pendingRevocations: details?.pendingRevocations ?? 0,
        exhaustedRevocations: details?.exhaustedRevocations ?? 0,
      },
    };
  }

  async connect(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.CANVA_INTEGRATION_MANAGE);
    this.refuseInRealMode(
      'In real Canva mode, connect through Canva authorization',
    );
    const account = this.provider.connect();
    const connectedAt = new Date();
    const connection = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.canvaConnection.upsert({
        where: { organizationId: user.organizationId },
        update: {
          status: CanvaConnectionStatus.CONNECTED,
          mode: account.mode,
          connectedById: user.id,
          connectedAt,
        },
        create: {
          organizationId: user.organizationId,
          status: CanvaConnectionStatus.CONNECTED,
          mode: account.mode,
          connectedById: user.id,
          connectedAt,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'canva.connection.connected',
        entityType: 'canva_connection',
        entityId: saved.id,
        metadata: { mode: account.mode },
      });
      return saved;
    });
    return {
      provider: 'CANVA',
      mode: account.mode,
      status: connection.status,
      connectedAt: connection.connectedAt,
      accountLabel: account.accountLabel,
      isRealConnection: account.mode === 'CANVA',
    };
  }

  async disconnect(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.CANVA_INTEGRATION_MANAGE);
    if (this.realMode) return this.disconnectReal(user);
    const disconnected = this.provider.disconnect();
    const connection = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.canvaConnection.upsert({
        where: { organizationId: user.organizationId },
        update: {
          status: CanvaConnectionStatus.DISCONNECTED,
          mode: disconnected.mode,
          connectedById: null,
          connectedAt: null,
        },
        create: {
          organizationId: user.organizationId,
          status: CanvaConnectionStatus.DISCONNECTED,
          mode: disconnected.mode,
        },
      });
      await this.audit.write(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'canva.connection.disconnected',
        entityType: 'canva_connection',
        entityId: saved.id,
        metadata: { mode: disconnected.mode },
      });
      return saved;
    });
    return {
      provider: 'CANVA',
      mode: disconnected.mode,
      status: connection.status,
      connectedAt: null,
      accountLabel: null,
      isRealConnection: false,
    };
  }

  // Real mode: the store deletes the credential and queues its tokens in one
  // transaction (§5.9); the revocation worker applies the same-user guard.
  private async disconnectReal(user: AuthenticatedPrincipal) {
    if (!this.persistenceEnabled || !this.accessTokens)
      throw new ConflictException(
        'Real Canva disconnection is not available yet',
      );
    let result: { removed: boolean; revocation: 'queued' | 'none' };
    try {
      result = await this.accessTokens.disconnect(user.organizationId, user.id);
    } catch (error: unknown) {
      if (error instanceof CanvaPersistenceUnavailableError)
        throw new ConflictException(
          'Real Canva disconnection is not available yet',
        );
      if (error instanceof CanvaWriteOutcomeUnknownError)
        throw new ServiceUnavailableException(
          'The Canva disconnection could not be confirmed; reload to check before retrying',
        );
      if (isDefiniteWriteFailure(error))
        throw new ServiceUnavailableException(
          'The Canva disconnection was not saved; try again',
        );
      throw error;
    }
    return {
      provider: 'CANVA',
      mode: 'CANVA',
      status: CanvaConnectionStatus.DISCONNECTED,
      connectedAt: null,
      accountLabel: null,
      isRealConnection: false,
      revocation: result.revocation,
    };
  }

  async listJobs(user: AuthenticatedPrincipal) {
    this.require(user, PERMISSIONS.CANVA_INTEGRATION_READ);
    const branches = user.permissions.includes(PERMISSIONS.BRANCH_MANAGE)
      ? await this.prisma.branch.findMany({
          where: { organizationId: user.organizationId, status: 'ACTIVE' },
          select: { id: true },
        })
      : await this.prisma.userBranchAccess.findMany({
          where: {
            userId: user.id,
            branch: { organizationId: user.organizationId, status: 'ACTIVE' },
          },
          select: { branchId: true },
        });
    const branchIds = branches.map((branch) =>
      'id' in branch ? branch.id : branch.branchId,
    );
    const jobs = await this.prisma.canvaJob.findMany({
      where: {
        organizationId: user.organizationId,
        branchId: { in: branchIds },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map((job) => this.publicJob(job));
  }

  async getJob(user: AuthenticatedPrincipal, id: string) {
    this.require(user, PERMISSIONS.CANVA_INTEGRATION_READ);
    const job = await this.prisma.canvaJob.findFirst({
      where: { id, organizationId: user.organizationId },
    });
    if (!job) throw new NotFoundException('Canva job not found');
    await this.assertBranch(user, job.branchId);
    return this.publicJob(job);
  }

  async createJob(
    user: AuthenticatedPrincipal,
    creativeId: string,
    idempotencyKey: string,
  ) {
    this.require(user, PERMISSIONS.CANVA_JOB_CREATE);
    // 409, not 5xx: the web client keeps retrying a 5xx with the same key.
    this.refuseInRealMode('Real Canva design preparation is not available yet');
    const creative = await this.prisma.creative.findFirst({
      where: { id: creativeId, organizationId: user.organizationId },
      include: {
        currentRevision: {
          include: { templateVersion: { include: { template: true } } },
        },
      },
    });
    if (!creative || !creative.currentRevision)
      throw new NotFoundException('Creative not found');
    await this.assertBranch(user, creative.branchId);
    const connection = await this.prisma.canvaConnection.findUnique({
      where: { organizationId: user.organizationId },
      select: { status: true },
    });
    if (connection?.status !== CanvaConnectionStatus.CONNECTED)
      throw new ConflictException('Connect the mock Canva provider first');

    const existing = await this.prisma.canvaJob.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: user.organizationId,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.creativeId !== creative.id)
        throw new ConflictException('Idempotency key already used');
      if (existing.status !== CanvaJobStatus.QUEUED)
        return this.publicJob(existing);
      // A QUEUED job never reached a persisted outcome; resume it against the
      // revision it was created for, not the creative's current revision.
      const stored = await this.prisma.creativeRevision.findFirst({
        where: { id: existing.creativeRevisionId, creativeId: creative.id },
        include: { templateVersion: true },
      });
      if (!stored) throw new NotFoundException('Creative not found');
      return this.prepareDesign(user, existing, stored);
    }

    const revision = creative.currentRevision;
    let job;
    try {
      job = await this.prisma.canvaJob.create({
        data: {
          organizationId: user.organizationId,
          branchId: creative.branchId,
          creativeId: creative.id,
          creativeRevisionId: revision.id,
          idempotencyKey,
          createdById: user.id,
          mode: this.provider.mode,
        },
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrent = await this.prisma.canvaJob.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: user.organizationId,
              idempotencyKey,
            },
          },
        });
        if (concurrent?.creativeId === creative.id)
          return this.publicJob(concurrent);
        throw new ConflictException('Idempotency key already used');
      }
      throw error;
    }

    return this.prepareDesign(user, job, revision);
  }

  // A provider rejection is a definite failure and finalizes the job as
  // FAILED. A failure to persist either outcome is uncertain: the job stays
  // QUEUED so a retry with the same Idempotency-Key can resume it.
  private async prepareDesign(
    user: AuthenticatedPrincipal,
    job: CanvaJob,
    revision: PreparableRevision,
  ) {
    let prepared: PreparedDesign;
    try {
      prepared = await this.provider.prepareDesign({
        creativeId: job.creativeId,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        templateVersionId: revision.templateVersionId,
        templateName: revision.templateVersion.name,
      });
    } catch {
      return this.finalize(
        user,
        job,
        {
          status: CanvaJobStatus.FAILED,
          errorCode: 'PROVIDER_UNAVAILABLE',
          errorMessage: 'The provider could not prepare a design.',
        },
        {
          action: 'canva.design.failed',
          metadata: { mode: this.provider.mode, status: 'FAILED' },
        },
      );
    }
    return this.finalize(
      user,
      job,
      {
        status: CanvaJobStatus.SUCCEEDED,
        externalDesignId: prepared.externalDesignId,
      },
      {
        action: 'canva.design.prepared',
        metadata: {
          mode: prepared.mode,
          status: prepared.status,
          externalDesignId: prepared.externalDesignId,
        },
      },
    );
  }

  // Moves a job out of QUEUED at most once. When a concurrent request already
  // finalized it, no second audit event is written and the persisted state is
  // returned instead.
  private async finalize(
    user: AuthenticatedPrincipal,
    job: CanvaJob,
    outcome: Prisma.CanvaJobUpdateManyMutationInput,
    event: { action: string; metadata: Prisma.InputJsonObject },
  ) {
    try {
      const persisted = await this.prisma.$transaction(async (tx) => {
        const transition = await tx.canvaJob.updateMany({
          where: { id: job.id, status: CanvaJobStatus.QUEUED },
          data: outcome,
        });
        if (transition.count === 1)
          await this.audit.write(tx, {
            organizationId: job.organizationId,
            actorUserId: user.id,
            action: event.action,
            entityType: 'canva_job',
            entityId: job.id,
            branchId: job.branchId,
            creativeId: job.creativeId,
            creativeRevisionId: job.creativeRevisionId,
            metadata: event.metadata,
          });
        return tx.canvaJob.findUniqueOrThrow({ where: { id: job.id } });
      });
      return this.publicJob(persisted);
    } catch (error: unknown) {
      throw new ServiceUnavailableException(
        'The Canva job outcome could not be saved; retry with the same Idempotency-Key',
        { cause: error },
      );
    }
  }
}

type PreparableRevision = Prisma.CreativeRevisionGetPayload<{
  include: { templateVersion: true };
}>;

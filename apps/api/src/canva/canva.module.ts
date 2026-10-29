import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { CanvaController } from './canva.controller';
import { CanvaService } from './canva.service';
import { CANVA_PROVIDER } from './canva-provider';
import { MockCanvaProvider } from './mock-canva.provider';
import { CanvaAccessTokenService } from './oauth/canva-access-token.service';
import {
  CanvaCapabilitiesClient,
  CanvaProfileClient,
} from './oauth/canva-account.clients';
import { PrismaCanvaCredentialStore } from './oauth/canva-credential.prisma-store';
import { CanvaOAuthCallbackController } from './oauth/canva-oauth-callback.controller';
import { PrismaCanvaOAuthAttemptStore } from './oauth/canva-oauth-attempt.prisma-store';
import {
  CANVA_AUTHORIZE_ENDPOINT,
  CANVA_CLOCK,
  CANVA_OAUTH_CONFIG,
  CANVA_OAUTH_ENDPOINTS,
  parseCanvaEnvironment,
  type CanvaOAuthConfig,
} from './oauth/canva-oauth.config';
import { CanvaOAuthService } from './oauth/canva-oauth.service';
import {
  CANVA_CREDENTIAL_STORE,
  CANVA_OAUTH_ATTEMPT_STORE,
  CANVA_RESEAL_STORE,
  CANVA_REVOCATION_QUEUE,
  UnavailableCanvaCredentialStore,
  UnavailableCanvaOAuthAttemptStore,
  UnavailableCanvaResealStore,
  UnavailableCanvaRevocationQueue,
} from './oauth/canva-oauth.stores';
import {
  CANVA_PRINCIPAL_CHECK,
  PrismaCanvaPrincipalCheck,
} from './oauth/canva-principal-check';
import { PrismaCanvaResealStore } from './oauth/canva-reseal.prisma-store';
import { PrismaCanvaRevocationQueue } from './oauth/canva-revocation.prisma-store';
import { CanvaRevocationWorker } from './oauth/canva-revocation.worker';
import { CanvaTokenResealService } from './oauth/canva-token-reseal.service';
import { CANVA_FETCH, CanvaTokenClient } from './oauth/canva-token.client';
import { CanvaIdentityClient } from './oauth/canva-identity.client';

// Durable stores only in real mode with CANVA_OAUTH_PERSISTENCE_ENABLED=true;
// otherwise the fail-closed stores, so no authorization can start.
const durable = (config: CanvaOAuthConfig) =>
  config.mode === 'canva' && config.persistence;

// Mock remains the default and the only design provider. Real mode enables
// the OAuth endpoints; durable OAuth storage (see
// docs/integrations/canva-oauth-persistence-proposal.md) is a separate
// opt-in, and the revocation worker another. The worker and the key reseal
// run from the operator command (canva-operations.main.ts), never on a
// schedule of their own.
@Module({
  imports: [AuthModule],
  controllers: [CanvaController, CanvaOAuthCallbackController],
  providers: [
    CanvaService,
    { provide: CANVA_PROVIDER, useClass: MockCanvaProvider },
    {
      provide: CANVA_OAUTH_CONFIG,
      useFactory: () => parseCanvaEnvironment(process.env),
    },
    { provide: CANVA_CLOCK, useValue: () => new Date() },
    // A constant: no configuration can change it (see the token's comment).
    {
      provide: CANVA_AUTHORIZE_ENDPOINT,
      useValue: CANVA_OAUTH_ENDPOINTS.authorize,
    },
    {
      provide: CANVA_FETCH,
      useValue: (url: string, init: RequestInit) => fetch(url, init),
    },
    {
      provide: CANVA_OAUTH_ATTEMPT_STORE,
      inject: [CANVA_OAUTH_CONFIG, PrismaService, AuditService],
      useFactory: (
        config: CanvaOAuthConfig,
        prisma: PrismaService,
        audit: AuditService,
      ) =>
        durable(config)
          ? new PrismaCanvaOAuthAttemptStore(prisma, audit)
          : new UnavailableCanvaOAuthAttemptStore(),
    },
    {
      provide: CANVA_CREDENTIAL_STORE,
      inject: [CANVA_OAUTH_CONFIG, PrismaService, AuditService],
      useFactory: (
        config: CanvaOAuthConfig,
        prisma: PrismaService,
        audit: AuditService,
      ) =>
        durable(config)
          ? new PrismaCanvaCredentialStore(prisma, audit)
          : new UnavailableCanvaCredentialStore(),
    },
    {
      provide: CANVA_REVOCATION_QUEUE,
      inject: [CANVA_OAUTH_CONFIG, PrismaService, AuditService],
      useFactory: (
        config: CanvaOAuthConfig,
        prisma: PrismaService,
        audit: AuditService,
      ) =>
        durable(config)
          ? new PrismaCanvaRevocationQueue(prisma, audit)
          : new UnavailableCanvaRevocationQueue(),
    },
    {
      provide: CANVA_RESEAL_STORE,
      inject: [CANVA_OAUTH_CONFIG, PrismaService, AuditService],
      useFactory: (
        config: CanvaOAuthConfig,
        prisma: PrismaService,
        audit: AuditService,
      ) =>
        durable(config)
          ? new PrismaCanvaResealStore(prisma, audit)
          : new UnavailableCanvaResealStore(),
    },
    { provide: CANVA_PRINCIPAL_CHECK, useClass: PrismaCanvaPrincipalCheck },
    CanvaTokenClient,
    CanvaIdentityClient,
    CanvaProfileClient,
    CanvaCapabilitiesClient,
    CanvaRevocationWorker,
    CanvaTokenResealService,
    CanvaOAuthService,
    CanvaAccessTokenService,
  ],
})
export class CanvaModule {}

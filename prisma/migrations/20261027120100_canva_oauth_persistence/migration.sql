-- Real Canva OAuth, part 2 of 2 (docs/integrations/canva-oauth-persistence-proposal.md).
-- Generated offline with `prisma migrate diff` (schema to schema, no database)
-- and reviewed: additive only. Nothing is dropped, renamed, or retyped, and
-- every new foreign key is ON UPDATE RESTRICT. Tokens and PKCE verifiers are
-- stored only as AES-256-GCM ciphertext; OAuth state and launch tokens only
-- as SHA-256 hashes.

-- AlterTable
ALTER TABLE "canva_connections" ADD COLUMN     "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "credentialVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastProviderErrorAt" TIMESTAMP(3),
ADD COLUMN     "lastProviderErrorKind" TEXT,
ADD COLUMN     "reauthorizationReason" TEXT,
ADD COLUMN     "reauthorizationRequiredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "canva_oauth_attempts" (
    "id" TEXT NOT NULL,
    "launchTokenHash" TEXT NOT NULL,
    "stateHash" TEXT,
    "browserBindingHash" TEXT,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "baseGeneration" INTEGER NOT NULL,
    "codeVerifierKeyVersion" INTEGER,
    "codeVerifierIv" TEXT,
    "codeVerifierCiphertext" TEXT,
    "codeVerifierTag" TEXT,
    "redirectUri" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "launchExpiresAt" TIMESTAMP(3) NOT NULL,
    "launchedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "canva_oauth_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canva_connection_candidates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "baseGeneration" INTEGER NOT NULL,
    "chainId" TEXT NOT NULL,
    "writeId" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "accessTokenIv" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "accessTokenTag" TEXT NOT NULL,
    "refreshTokenIv" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "refreshTokenTag" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "canvaUserId" TEXT NOT NULL,
    "canvaTeamId" TEXT NOT NULL,
    "canvaDisplayName" TEXT,
    "hasAutofill" BOOLEAN NOT NULL,
    "hasBrandTemplates" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canva_connection_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canva_credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectedById" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "writeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "accessTokenIv" TEXT NOT NULL,
    "accessTokenCiphertext" TEXT NOT NULL,
    "accessTokenTag" TEXT NOT NULL,
    "refreshTokenIv" TEXT NOT NULL,
    "refreshTokenCiphertext" TEXT NOT NULL,
    "refreshTokenTag" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "scopes" TEXT[],
    "canvaUserId" TEXT NOT NULL,
    "canvaTeamId" TEXT NOT NULL,
    "refreshLeaseOwner" TEXT,
    "refreshLeaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canva_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canva_pending_revocations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "chainId" TEXT NOT NULL,
    "canvaUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "keyVersion" INTEGER,
    "refreshTokenIv" TEXT,
    "refreshTokenCiphertext" TEXT,
    "refreshTokenTag" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimToken" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "callStartedAt" TIMESTAMP(3),
    "possibleEffectUntil" TIMESTAMP(3),
    "outcome" TEXT,
    "lastErrorKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "canva_pending_revocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canva_accounts" (
    "canvaUserId" TEXT NOT NULL,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canva_accounts_pkey" PRIMARY KEY ("canvaUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "canva_oauth_attempts_launchTokenHash_key" ON "canva_oauth_attempts"("launchTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "canva_oauth_attempts_stateHash_key" ON "canva_oauth_attempts"("stateHash");

-- CreateIndex
CREATE INDEX "canva_oauth_attempts_organizationId_launchExpiresAt_idx" ON "canva_oauth_attempts"("organizationId", "launchExpiresAt");

-- CreateIndex
CREATE INDEX "canva_oauth_attempts_organizationId_expiresAt_idx" ON "canva_oauth_attempts"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "canva_connection_candidates_organizationId_key" ON "canva_connection_candidates"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_connection_candidates_attemptId_key" ON "canva_connection_candidates"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_connection_candidates_chainId_key" ON "canva_connection_candidates"("chainId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_connection_candidates_writeId_key" ON "canva_connection_candidates"("writeId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_connection_candidates_canvaUserId_key" ON "canva_connection_candidates"("canvaUserId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_credentials_organizationId_key" ON "canva_credentials"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_credentials_chainId_key" ON "canva_credentials"("chainId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_credentials_canvaUserId_key" ON "canva_credentials"("canvaUserId");

-- CreateIndex
CREATE INDEX "canva_credentials_keyVersion_idx" ON "canva_credentials"("keyVersion");

-- CreateIndex
CREATE INDEX "canva_pending_revocations_state_nextAttemptAt_idx" ON "canva_pending_revocations"("state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "canva_pending_revocations_canvaUserId_state_idx" ON "canva_pending_revocations"("canvaUserId", "state");

-- CreateIndex
CREATE INDEX "canva_pending_revocations_organizationId_finishedAt_idx" ON "canva_pending_revocations"("organizationId", "finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "canva_pending_revocations_chainId_reason_key" ON "canva_pending_revocations"("chainId", "reason");

-- CreateIndex
CREATE INDEX "canva_accounts_organizationId_idx" ON "canva_accounts"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "canva_accounts_canvaUserId_organizationId_key" ON "canva_accounts"("canvaUserId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "users_id_organizationId_key" ON "users"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_id_userId_key" ON "auth_sessions"("id", "userId");

-- AddForeignKey
ALTER TABLE "canva_oauth_attempts" ADD CONSTRAINT "canva_oauth_attempts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_oauth_attempts" ADD CONSTRAINT "canva_oauth_attempts_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "users"("id", "organizationId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_oauth_attempts" ADD CONSTRAINT "canva_oauth_attempts_sessionId_userId_fkey" FOREIGN KEY ("sessionId", "userId") REFERENCES "auth_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_connection_candidates" ADD CONSTRAINT "canva_connection_candidates_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "canva_connections"("organizationId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_connection_candidates" ADD CONSTRAINT "canva_connection_candidates_canvaUserId_organizationId_fkey" FOREIGN KEY ("canvaUserId", "organizationId") REFERENCES "canva_accounts"("canvaUserId", "organizationId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_connection_candidates" ADD CONSTRAINT "canva_connection_candidates_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "canva_oauth_attempts"("id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_connection_candidates" ADD CONSTRAINT "canva_connection_candidates_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "users"("id", "organizationId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_connection_candidates" ADD CONSTRAINT "canva_connection_candidates_sessionId_userId_fkey" FOREIGN KEY ("sessionId", "userId") REFERENCES "auth_sessions"("id", "userId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_credentials" ADD CONSTRAINT "canva_credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "canva_connections"("organizationId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_credentials" ADD CONSTRAINT "canva_credentials_canvaUserId_organizationId_fkey" FOREIGN KEY ("canvaUserId", "organizationId") REFERENCES "canva_accounts"("canvaUserId", "organizationId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_credentials" ADD CONSTRAINT "canva_credentials_connectedById_organizationId_fkey" FOREIGN KEY ("connectedById", "organizationId") REFERENCES "users"("id", "organizationId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_pending_revocations" ADD CONSTRAINT "canva_pending_revocations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "canva_connections"("organizationId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "canva_pending_revocations" ADD CONSTRAINT "canva_pending_revocations_canvaUserId_fkey" FOREIGN KEY ("canvaUserId") REFERENCES "canva_accounts"("canvaUserId") ON DELETE RESTRICT ON UPDATE RESTRICT;


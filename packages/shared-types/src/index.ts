export interface HealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
}

export interface BranchSummary {
  id: string;
  name: string;
  code: string;
}

export interface AuthenticatedUserResponse {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  permissions: string[];
  branches: BranchSummary[];
}

export interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthenticatedUserResponse;
}

export interface BranchResponse extends BranchSummary {
  status: string;
}
export interface OrganizationResponse {
  id: string;
  name: string;
  code: string;
  status: string;
}

export interface BranchDetails extends BranchResponse {
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  googleMapsUrl: string | null;
  timezone: string;
}

export interface OrganizationUserSummary {
  id: string;
  name: string;
  email: string;
  status: string;
}

export interface UserBranchAccessResponse {
  userId: string;
  branch: BranchDetails;
}

export type TemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type TemplateFieldType =
  | 'TEXT'
  | 'MULTILINE_TEXT'
  | 'IMAGE'
  | 'LOGO'
  | 'PHONE'
  | 'URL'
  | 'DATE'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'COLOR';
export type TemplateDataSource =
  'ORGANIZATION_BRAND' | 'EFFECTIVE_BRAND' | 'BRANCH' | 'CUSTOM';
export interface TemplateFieldResponse {
  id: string;
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  defaultValue: unknown;
  validationRules: Record<string, number> | null;
  helpText: string | null;
  displayOrder: number;
  dataSource: TemplateDataSource | null;
  sourceKey: string | null;
}
export interface TemplateVersionResponse {
  id: string;
  templateId?: string;
  versionNumber: number;
  name: string;
  description: string | null;
  category: string | null;
  formatName: string;
  width: number;
  height: number;
  unit: 'PX' | 'MM' | 'CM' | 'IN';
  immutableAt: string | null;
  createdAt: string;
  fields: TemplateFieldResponse[];
}
export interface TemplateResponse {
  id: string;
  name: string;
  code: string;
  description: string | null;
  category: string | null;
  status: TemplateStatus;
  formatName: string;
  width: number;
  height: number;
  unit: 'PX' | 'MM' | 'CM' | 'IN';
  currentVersionNumber: number;
  activeVersionNumber: number | null;
  updatedAt: string;
  versions?: TemplateVersionResponse[];
  currentVersion?: TemplateVersionResponse | null;
}

export interface CreativeRevisionResponse {
  id: string;
  revisionNumber: number;
  templateVersionId: string;
  values: Record<string, unknown>;
  summary: string | null;
  createdById: string;
  createdAt: string;
  templateVersion: TemplateVersionResponse;
}
// The latest approval decision of a creative, tied to the exact revision
// that was reviewed.
export interface ApprovedRevisionSummary {
  revisionId: string;
  revisionNumber: number;
  approvedAt: string;
  reviewer: { id: string; name: string };
}

export interface CreativeResponse {
  id: string;
  organizationId: string;
  branchId: string;
  campaignId: string | null;
  name: string;
  // Status of the current revision: the stage of a run for that revision, or
  // DRAFT when the latest run reviewed an older revision.
  status: string;
  // Latest approved revision, which may be older than the current one.
  approvedRevision?: ApprovedRevisionSummary | null;
  // Whether the current revision's latest decision is an approval.
  currentRevisionApproved?: boolean;
  currentRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  currentRevision: CreativeRevisionResponse | null;
  branch?: BranchSummary;
  campaign?: { id: string; name: string } | null;
}

export interface CanvaIntegrationStatus {
  provider: 'CANVA';
  mode: 'MOCK' | 'CANVA';
  status: 'CONNECTED' | 'DISCONNECTED';
  connectedAt: string | null;
  accountLabel: string | null;
  isRealConnection: boolean;
  // Real Canva mode with durable OAuth storage only.
  canva?: CanvaRealConnectionDetails;
  // Present after a real-mode disconnect: the tokens were queued for the
  // revocation worker, never revoked inline.
  revocation?: 'queued' | 'none';
}

export interface CanvaRealConnectionDetails {
  reauthorizationRequired: boolean;
  reauthorizationReason: string | null;
  configurationError: boolean;
  pendingRevocations: number;
  exhaustedRevocations: number;
}

// POST /integrations/canva/oauth/authorize. The browser posts launchToken
// to launchUrl in a top-level form (field name launch_token); the token is
// single-use, valid for 60 seconds, and must never be stored.
export interface CanvaAuthorizationStart {
  launchUrl: string;
  launchToken: string;
  expiresAt: string;
}

// The fixed values the callback reports in /?canva=<outcome>.
export type CanvaOAuthOutcome =
  | 'connected'
  | 'denied'
  | 'invalid_request'
  | 'expired_or_used'
  | 'not_authorized'
  | 'conflict'
  | 'account_unavailable'
  | 'pending_confirmation'
  | 'account_ineligible'
  | 'insufficient_scope'
  | 'retry_connect'
  | 'unavailable'
  | 'disabled'
  | 'failed';

export type CanvaCandidateWarning =
  'differentAccount' | 'missingDisplayName' | 'scopesNotReported';

// GET /integrations/canva/oauth/candidate: the pending Canva account, only
// for the administrator and session that started the flow. Never includes
// tokens. canvaDisplayName is untrusted text: render it as text only.
export interface CanvaPendingCandidate {
  id: string;
  canvaDisplayName: string | null;
  // Shortened opaque IDs, enough to tell accounts apart.
  canvaUserId: string;
  canvaTeamId: string;
  scopes: {
    // False when Canva did not report the granted scopes.
    reported: boolean;
    granted: string[];
    required: string[];
    missing: string[];
  };
  capabilities: { autofill: boolean; brandTemplate: boolean };
  startedAt: string;
  expiresAt: string;
  warnings: CanvaCandidateWarning[];
}

// POST /integrations/canva/oauth/candidate/confirm body.
export interface CanvaCandidateConfirmation {
  candidateId: string;
  acknowledgements: Partial<Record<CanvaCandidateWarning, boolean>>;
}

export interface CanvaCandidateConfirmed {
  status: 'CONNECTED';
  replacedPrevious: boolean;
  sameCanvaUser: boolean;
}

// GET /integrations/canva/revocations: exhausted revocations awaiting an
// administrator's retry or dismissal.
export interface CanvaExhaustedRevocation {
  id: string;
  reason: string;
  attempts: number;
  lastErrorKind: string | null;
  createdAt: string;
  exhaustedAt: string;
}

export interface CanvaJobResponse {
  id: string;
  organizationId: string;
  branchId: string;
  creativeId: string;
  creativeRevisionId: string;
  status: 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  mode: 'MOCK' | 'CANVA';
  externalDesignId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// DELETE /assets/:assetId, and PATCH /assets/:assetId when it changes the
// asset's branch, answer 409 with this body while the asset is still
// referenced in the organization; the asset record (including its branch)
// and its file are left unchanged.
// GET /assets/:assetId and each GET /assets entry. Never includes the storage
// key or any filesystem path; the bytes are only served by the authenticated
// /assets/:assetId/content (inline) and /assets/:assetId/download routes.
export interface AssetResponse {
  id: string;
  organizationId: string;
  branchId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  status: 'ACTIVE' | 'DELETED';
  createdAt: string;
  updatedAt: string;
}

export type AssetInUseReason =
  'CREATIVE_REVISION' | 'ORGANIZATION_BRAND_LOGO' | 'BRANCH_BRAND_LOGO';

export interface AssetInUseConflictResponse {
  statusCode: 409;
  error: 'Conflict';
  message: string;
  reason: AssetInUseReason;
}

// GET /assets/:assetId/usage: where an active asset is used in the caller's
// organization. Read-only. Details cover only branches the caller can access;
// other references are counted in hiddenReferenceCount. inUse covers every
// reference, matching what blocks deletion and branch moves.
export interface AssetUsageField {
  key: string;
  // From the revision's template version; null when the field is not found.
  label: string | null;
  type: string | null;
}

export interface AssetUsageCreativeRevision {
  creativeId: string;
  creativeName: string;
  branchId: string;
  branchName: string;
  revisionId: string;
  revisionNumber: number;
  isCurrentRevision: boolean;
  fields: AssetUsageField[];
}

export interface AssetUsageResponse {
  assetId: string;
  inUse: boolean;
  creativeRevisions: AssetUsageCreativeRevision[];
  organizationBrandProfile: {
    profileId: string;
    displayName: string | null;
  } | null;
  branchBrandProfiles: Array<{
    branchId: string;
    branchName: string;
    branchCode: string;
  }>;
  hiddenReferenceCount: number;
}

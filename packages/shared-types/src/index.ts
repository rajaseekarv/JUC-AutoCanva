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
export interface CreativeResponse {
  id: string;
  organizationId: string;
  branchId: string;
  campaignId: string | null;
  name: string;
  status: string;
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

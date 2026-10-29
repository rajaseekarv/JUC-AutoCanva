import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  CANVA_OAUTH_CONFIG,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import type { CanvaCapabilities } from './canva-oauth.stores';
import { CanvaIdentityError, getCanvaUserJson } from './canva-identity.client';
import { CANVA_FETCH, type CanvaFetch } from './canva-token.client';

// Documented at https://www.canva.dev/docs/connect/api-reference/users/users-profile/
// and https://www.canva.dev/docs/connect/api-reference/users/get-user-capabilities/.
// Both require the profile:read scope.
export const CANVA_PROFILE_ENDPOINT =
  'https://api.canva.com/rest/v1/users/me/profile';
export const CANVA_CAPABILITIES_ENDPOINT =
  'https://api.canva.com/rest/v1/users/me/capabilities';

const DISPLAY_NAME_MAX_CHARS = 256;
// C0 and C1 controls, and the Unicode bidirectional overrides and isolates.
const UNSAFE_DISPLAY_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

// The display name is attacker-chosen text shown to administrators. It is
// rendered as text only and never logged or audited; this only removes
// characters that could disguise it. Empty results become null.
export function sanitizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(UNSAFE_DISPLAY_CHARACTERS, '')
    .trim()
    .slice(0, DISPLAY_NAME_MAX_CHARS)
    .trim();
  return cleaned || null;
}

// Granted-scope check (§2.3). Canva's token response may omit `scope`;
// `reported` is false then, and the confirmation screen says so.
export function grantedScopeCheck(
  granted: readonly string[],
  required: readonly string[],
): { reported: boolean; missing: string[] } {
  const normalized = new Set(
    granted.flatMap((scope) => scope.split(/\s+/)).filter(Boolean),
  );
  if (!normalized.size) return { reported: false, missing: [] };
  return {
    reported: true,
    missing: required.filter((scope) => !normalized.has(scope)),
  };
}

const profileSchema = z.object({
  profile: z.object({ display_name: z.unknown().optional() }),
});

// The capabilities response is documented as a list of capability names.
// That shape is assumption A-S1 in the proposal: anything else is refused as
// invalid_response rather than guessed at.
const capabilitiesSchema = z.object({
  capabilities: z.array(z.string().max(128)).max(256),
});

@Injectable()
export class CanvaProfileClient {
  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_FETCH) private readonly fetchImpl: CanvaFetch,
  ) {}

  // The sanitized display name, or null when Canva has none.
  async displayName(accessToken: string): Promise<string | null> {
    const { status, body } = await getCanvaUserJson(
      this.config,
      this.fetchImpl,
      CANVA_PROFILE_ENDPOINT,
      accessToken,
    );
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success)
      throw new CanvaIdentityError('invalid_response', status);
    return sanitizeDisplayName(parsed.data.profile.display_name);
  }
}

@Injectable()
export class CanvaCapabilitiesClient {
  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_FETCH) private readonly fetchImpl: CanvaFetch,
  ) {}

  // Unknown capability names and duplicates are ignored.
  async capabilities(accessToken: string): Promise<CanvaCapabilities> {
    const { status, body } = await getCanvaUserJson(
      this.config,
      this.fetchImpl,
      CANVA_CAPABILITIES_ENDPOINT,
      accessToken,
    );
    const parsed = capabilitiesSchema.safeParse(body);
    if (!parsed.success)
      throw new CanvaIdentityError('invalid_response', status);
    const names = new Set(parsed.data.capabilities);
    return {
      autofill: names.has('autofill'),
      brandTemplate: names.has('brand_template'),
    };
  }
}

import type { AuthenticatedUserResponse } from '@adflow/shared-types';

export interface AuthenticatedPrincipal extends AuthenticatedUserResponse {
  sessionId: string;
}

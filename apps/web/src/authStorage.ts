// Persists only the access token and its expiry so a reload or new tab can
// revalidate the existing server session through GET /auth/me. Identity,
// permissions, and branch access are never stored; they always come from the API.
export const SESSION_STORAGE_KEY = 'adflow.session';

const MAX_TOKEN_LENGTH = 4096;

export type StoredSession = { accessToken: string; expiresAt: number };

function sessionStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function parseStoredSession(raw: string): StoredSession | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { accessToken, expiresAt } = value as Record<string, unknown>;
  if (
    typeof accessToken !== 'string' ||
    accessToken.length === 0 ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  )
    return null;
  return { accessToken, expiresAt };
}

function readRawSession(store: Storage): string | null {
  try {
    return store.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Returns a usable saved session, removing malformed or locally expired entries. */
export function loadStoredSession(now = Date.now()): StoredSession | null {
  const store = sessionStore();
  if (!store) return null;
  const raw = readRawSession(store);
  if (raw === null) return null;
  const stored = parseStoredSession(raw);
  if (!stored || stored.expiresAt <= now) {
    removeStoredSession();
    return null;
  }
  return stored;
}

export function saveStoredSession(
  accessToken: string,
  expiresInSeconds: number,
  now = Date.now(),
): void {
  const stored: StoredSession = {
    accessToken,
    expiresAt: now + expiresInSeconds * 1000,
  };
  try {
    sessionStore()?.setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage may be unavailable (private mode, quota); the session stays in memory.
  }
}

/**
 * Removes the saved session. When a token is given, a saved entry for a
 * different token (for example a newer sign-in from another tab) is kept.
 */
export function removeStoredSession(accessToken?: string): void {
  const store = sessionStore();
  if (!store) return;
  if (accessToken !== undefined) {
    const raw = readRawSession(store);
    const stored = raw === null ? null : parseStoredSession(raw);
    if (stored && stored.accessToken !== accessToken) return;
  }
  try {
    store.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing further can be cleared when storage is unavailable.
  }
}

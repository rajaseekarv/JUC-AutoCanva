import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CANVA_OAUTH_CONFIG,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import {
  CANVA_RESEAL_STORE,
  CanvaPersistenceUnavailableError,
  type CanvaKeyInventory,
  type CanvaResealStore,
  type CanvaResealedValues,
  type CanvaSealedKind,
  type StaleCanvaSeal,
} from './canva-oauth.stores';
import {
  CanvaCipherError,
  sealContext,
  type CanvaTokenKeyring,
  type SealedValue,
} from './canva-token-cipher';

export type CanvaResealSummary = {
  currentKeyVersion: number;
  scanned: number;
  resealed: number;
  // The row changed since it was listed (refresh, reconnect, disconnect,
  // worker, consumption), or a refresh lease was active. A later run picks
  // up anything still sealed with an old key.
  skipped: number;
  // No key is configured for the row's version. Left untouched: removing a
  // key too early is an operator error, and destroying rows would make it
  // irreversible.
  missingKey: number;
  // A key is configured but the value does not open (corruption or a wrong
  // key). Left untouched; normal use marks such a credential undecryptable.
  undecryptable: number;
  // Sealed with a newer key than this process's current one (another
  // instance already promoted it). Left untouched: resealing only moves
  // forward.
  newerKey: number;
  // A store failure stopped the run. Nothing is half-written: each reseal
  // is one conditional write. Run again to resume.
  interrupted: boolean;
  // Rows still sealed with another version after the run (null when the
  // inventory could not be read).
  remaining: number | null;
};

export type CanvaKeyRetirement = {
  keyVersion: number;
  rows: number;
  // True only when no row of any kind is sealed with this version.
  safeToRetire: boolean;
};

export type CanvaKeyReport = {
  currentKeyVersion: number;
  inventory: CanvaKeyInventory;
  // Previous (older) versions only.
  retirement: CanvaKeyRetirement[];
  // Configured versions newer than the current one: pre-staged for a
  // rotation (decrypt only), not yet promoted. While any exists, the reseal
  // refuses to run.
  prestaged: number[];
};

// The reseal refuses to run: it would move rows backwards.
export class CanvaResealRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvaResealRefusedError';
  }
}

const KINDS: CanvaSealedKind[] = [
  'credential',
  'candidate',
  'revocation',
  'attempt',
];
const PAGE = 100;
export const CANVA_RESEAL_DEFAULT_LIMIT = 1_000;

// §5.11 key rotation. Re-encrypts every stored Canva value sealed with a
// previous key under the current key (CANVA_TOKEN_ENCRYPTION_KEY_VERSION).
// - Each value is opened, sealed again with the same associated data, and
//   the new ciphertext is opened once more before it is written, so a row
//   is never written with a value the current key cannot read.
// - Each write is conditional (§5.11), so a concurrent refresh, reconnect,
//   disconnect, consumption, or worker change always wins, and running the
//   job twice, or after a crash, is harmless.
// - Plaintext exists only in local variables. Logs and results carry counts
//   and key versions only.
// - It makes no external call and never deletes, marks, or revokes.
// Retire an old key only when inventory() reports safeToRetire for it.
@Injectable()
export class CanvaTokenResealService {
  private readonly logger = new Logger('CanvaTokenReseal');

  constructor(
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
    @Inject(CANVA_RESEAL_STORE) private readonly store: CanvaResealStore,
  ) {}

  private keyring(): CanvaTokenKeyring {
    const config = this.config;
    if (config.mode !== 'canva' || !config.persistence)
      throw new CanvaPersistenceUnavailableError();
    return config.keyring;
  }

  async inventory(): Promise<CanvaKeyReport> {
    const keyring = this.keyring();
    const inventory = await this.store.inventory();
    const rowsFor = (version: number) =>
      inventory
        .filter((entry) => entry.keyVersion === version)
        .reduce((total, entry) => total + entry.rows, 0);
    return {
      currentKeyVersion: keyring.currentVersion,
      inventory,
      retirement: keyring.previousVersions
        .filter((keyVersion) => keyVersion < keyring.currentVersion)
        .map((keyVersion) => {
          const rows = rowsFor(keyVersion);
          return { keyVersion, rows, safeToRetire: rows === 0 };
        }),
      prestaged: keyring.previousVersions.filter(
        (keyVersion) => keyVersion > keyring.currentVersion,
      ),
    };
  }

  async run(options: { limit?: number } = {}): Promise<CanvaResealSummary> {
    const keyring = this.keyring();
    const limit = options.limit ?? CANVA_RESEAL_DEFAULT_LIMIT;
    const current = keyring.currentVersion;
    // A newer configured key means this process is in the pre-staging step
    // of a rotation (or was rolled back): resealing here would rewrite rows
    // that promoted instances sealed with the newer key back to an older one.
    if (keyring.previousVersions.some((version) => version > current))
      throw new CanvaResealRefusedError(
        'Refusing to reseal: a newer key version is configured than the current one. Promote it first.',
      );
    const summary: CanvaResealSummary = {
      currentKeyVersion: current,
      scanned: 0,
      resealed: 0,
      skipped: 0,
      missingKey: 0,
      undecryptable: 0,
      newerKey: 0,
      interrupted: false,
      remaining: null,
    };
    try {
      for (const kind of KINDS) {
        let after: string | null = null;
        for (;;) {
          const pageSize = Math.min(PAGE, limit - summary.scanned);
          if (pageSize <= 0) break;
          const page = await this.store.listStale(
            kind,
            current,
            after,
            pageSize,
          );
          for (const row of page) {
            after = row.id;
            summary.scanned += 1;
            if (row.keyVersion > current) {
              summary.newerKey += 1;
              continue;
            }
            const values = this.resealedValues(keyring, row);
            if (values === 'missing_key') summary.missingKey += 1;
            else if (values === 'undecryptable') summary.undecryptable += 1;
            else if (await this.store.reseal(row, values))
              summary.resealed += 1;
            else summary.skipped += 1;
          }
          if (page.length < pageSize) break;
        }
      }
    } catch {
      summary.interrupted = true;
      this.logger.warn('Canva token reseal interrupted; run it again');
    }
    try {
      summary.remaining = (await this.store.inventory())
        .filter((entry) => entry.keyVersion < current)
        .reduce((total, entry) => total + entry.rows, 0);
    } catch {
      summary.remaining = null;
    }
    this.logger.log(
      `Canva token reseal to key ${current}: ${summary.resealed} resealed, ${summary.skipped} skipped, ${summary.missingKey} missing key, ${summary.undecryptable} undecryptable, ${summary.remaining ?? 'unknown'} remaining`,
    );
    return summary;
  }

  private resealedValues(
    keyring: CanvaTokenKeyring,
    row: StaleCanvaSeal,
  ): CanvaResealedValues | 'missing_key' | 'undecryptable' {
    if (!keyring.hasKey(row.keyVersion)) return 'missing_key';
    const organizationId = row.organizationId;
    try {
      switch (row.kind) {
        case 'credential':
        case 'candidate':
          return {
            keyVersion: keyring.currentVersion,
            accessToken: resealValue(
              keyring,
              row.accessToken,
              sealContext.accessToken(organizationId),
            ),
            refreshToken: resealValue(
              keyring,
              row.refreshToken,
              sealContext.refreshToken(organizationId),
            ),
          };
        case 'revocation':
          return {
            keyVersion: keyring.currentVersion,
            refreshToken: resealValue(
              keyring,
              row.refreshToken,
              sealContext.refreshToken(organizationId),
            ),
          };
        case 'attempt':
          return {
            keyVersion: keyring.currentVersion,
            codeVerifier: resealValue(
              keyring,
              row.codeVerifier,
              sealContext.codeVerifier(organizationId),
            ),
          };
      }
    } catch (error: unknown) {
      if (error instanceof CanvaCipherError) return 'undecryptable';
      throw error;
    }
  }
}

// Opens with the value's own key, seals with the current key under the same
// associated data, and verifies the new value before anything is written.
function resealValue(
  keyring: CanvaTokenKeyring,
  value: SealedValue,
  context: string,
): SealedValue {
  const plaintext = keyring.open(value, context);
  const resealed = keyring.seal(plaintext, context);
  if (keyring.open(resealed, context) !== plaintext)
    throw new CanvaCipherError();
  return resealed;
}

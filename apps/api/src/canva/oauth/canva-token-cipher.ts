import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Authenticated encryption for Canva tokens and PKCE verifiers at rest:
// AES-256-GCM with a random 96-bit IV per value. The key version travels with
// each sealed value so keys can rotate: new values use the current key, and
// previous keys stay available for decryption until data is re-encrypted.
export type SealedValue = {
  keyVersion: number;
  iv: string;
  ciphertext: string;
  tag: string;
};

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CanvaCipherError extends Error {
  constructor() {
    // Deliberately generic: never reveal which part failed or any input.
    super('Canva credential could not be decrypted');
    this.name = 'CanvaCipherError';
  }
}

// Accepts standard or URL-safe base64 for exactly 32 bytes; otherwise null.
export function decodeEncryptionKey(encoded: string): Buffer | null {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(normalized)) return null;
  const key = Buffer.from(
    normalized.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  return key.length === KEY_BYTES ? key : null;
}

export class CanvaTokenKeyring {
  readonly #current: { version: number; key: Buffer };
  readonly #keys: Map<number, Buffer>;

  constructor(
    current: { version: number; key: Buffer },
    previous: ReadonlyMap<number, Buffer> = new Map(),
  ) {
    if (current.key.length !== KEY_BYTES)
      throw new Error('Canva token encryption key must be 32 bytes');
    if (previous.has(current.version))
      throw new Error('Previous Canva token keys must use other versions');
    this.#current = current;
    this.#keys = new Map([...previous, [current.version, current.key]]);
  }

  get currentVersion(): number {
    return this.#current.version;
  }

  // `context` is bound as additional authenticated data, so a value sealed
  // for one organization or purpose cannot be opened as another.
  seal(plaintext: string, context: string): SealedValue {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#current.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      keyVersion: this.#current.version,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
  }

  open(sealed: SealedValue, context: string): string {
    const key = this.#keys.get(sealed.keyVersion);
    if (!key) throw new CanvaCipherError();
    try {
      const iv = Buffer.from(sealed.iv, 'base64url');
      const tag = Buffer.from(sealed.tag, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
        throw new CanvaCipherError();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(sealed.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new CanvaCipherError();
    }
  }

  // Whether a key for this version is configured (current or previous).
  hasKey(version: number): boolean {
    return this.#keys.has(version);
  }

  // Configured versions other than the current one: candidates for
  // retirement once nothing is sealed with them.
  get previousVersions(): number[] {
    return [...this.#keys.keys()]
      .filter((version) => version !== this.#current.version)
      .sort((a, b) => a - b);
  }

  // True when the value should be re-sealed with the current key.
  needsRotation(sealed: SealedValue): boolean {
    return sealed.keyVersion !== this.#current.version;
  }

  toJSON(): string {
    return '[redacted keyring]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[redacted keyring]';
  }
}

// Binds sealed values to their owner and use. Kept in one place so stores and
// services cannot drift apart.
export const sealContext = {
  codeVerifier: (organizationId: string) =>
    `canva:oauth-verifier:${organizationId}`,
  accessToken: (organizationId: string) =>
    `canva:access-token:${organizationId}`,
  refreshToken: (organizationId: string) =>
    `canva:refresh-token:${organizationId}`,
};

import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  CanvaCipherError,
  CanvaTokenKeyring,
  decodeEncryptionKey,
  sealContext,
} from './canva-token-cipher';

const keyOne = Buffer.alloc(32, 1);
const keyTwo = Buffer.alloc(32, 2);
const context = sealContext.refreshToken('org-1');
const token = 'test-only-refresh-token-value';

describe('CanvaTokenKeyring', () => {
  it('round-trips a value and never stores plaintext', () => {
    const keyring = new CanvaTokenKeyring({ version: 1, key: keyOne });
    const sealed = keyring.seal(token, context);
    expect(sealed.keyVersion).toBe(1);
    expect(JSON.stringify(sealed)).not.toContain(token);
    expect(Buffer.from(sealed.iv, 'base64url')).toHaveLength(12);
    expect(Buffer.from(sealed.tag, 'base64url')).toHaveLength(16);
    expect(keyring.open(sealed, context)).toBe(token);
  });

  it('uses a fresh IV for every value', () => {
    const keyring = new CanvaTokenKeyring({ version: 1, key: keyOne });
    const first = keyring.seal(token, context);
    const second = keyring.seal(token, context);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it.each([
    ['ciphertext', 'ciphertext'],
    ['authentication tag', 'tag'],
    ['IV', 'iv'],
  ] as const)('rejects a tampered %s', (_label, field) => {
    const keyring = new CanvaTokenKeyring({ version: 1, key: keyOne });
    const sealed = keyring.seal(token, context);
    const bytes = Buffer.from(sealed[field], 'base64url');
    bytes[0] ^= 0xff;
    expect(() =>
      keyring.open(
        { ...sealed, [field]: bytes.toString('base64url') },
        context,
      ),
    ).toThrow(CanvaCipherError);
  });

  it('binds values to their organization and purpose', () => {
    const keyring = new CanvaTokenKeyring({ version: 1, key: keyOne });
    const sealed = keyring.seal(token, context);
    expect(() =>
      keyring.open(sealed, sealContext.refreshToken('org-2')),
    ).toThrow(CanvaCipherError);
    expect(() =>
      keyring.open(sealed, sealContext.accessToken('org-1')),
    ).toThrow(CanvaCipherError);
  });

  it('opens values sealed with a previous key after rotation and flags them for re-encryption', () => {
    const before = new CanvaTokenKeyring({ version: 1, key: keyOne });
    const sealed = before.seal(token, context);
    const after = new CanvaTokenKeyring(
      { version: 2, key: keyTwo },
      new Map([[1, keyOne]]),
    );
    expect(after.open(sealed, context)).toBe(token);
    expect(after.needsRotation(sealed)).toBe(true);
    const resealed = after.seal(after.open(sealed, context), context);
    expect(resealed.keyVersion).toBe(2);
    expect(after.needsRotation(resealed)).toBe(false);
  });

  it('fails closed for an unknown key version', () => {
    const keyring = new CanvaTokenKeyring({ version: 2, key: keyTwo });
    const sealed = new CanvaTokenKeyring({ version: 1, key: keyOne }).seal(
      token,
      context,
    );
    expect(() => keyring.open(sealed, context)).toThrow(CanvaCipherError);
  });

  it('reports failures without any detail about the input', () => {
    const keyring = new CanvaTokenKeyring({ version: 1, key: keyOne });
    const sealed = keyring.seal(token, context);
    try {
      keyring.open({ ...sealed, tag: 'AAAAAAAAAAAAAAAAAAAAAA' }, context);
    } catch (error) {
      expect((error as Error).message).toBe(
        'Canva credential could not be decrypted',
      );
    }
  });

  it('redacts itself when logged or serialized', () => {
    const keyring = new CanvaTokenKeyring({ version: 1, key: keyOne });
    expect(JSON.stringify({ keyring })).toBe(
      '{"keyring":"[redacted keyring]"}',
    );
    expect(inspect(keyring)).toBe('[redacted keyring]');
  });

  it('rejects a key of the wrong size or a previous key reusing the current version', () => {
    expect(
      () => new CanvaTokenKeyring({ version: 1, key: Buffer.alloc(16) }),
    ).toThrow();
    expect(
      () =>
        new CanvaTokenKeyring(
          { version: 1, key: keyOne },
          new Map([[1, keyTwo]]),
        ),
    ).toThrow();
  });
});

describe('decodeEncryptionKey', () => {
  it('accepts 32 bytes as standard or URL-safe base64', () => {
    const key = Buffer.alloc(32, 250);
    expect(decodeEncryptionKey(key.toString('base64'))).toEqual(key);
    expect(decodeEncryptionKey(key.toString('base64url'))).toEqual(key);
  });

  it('rejects other lengths and non-base64 input', () => {
    expect(decodeEncryptionKey(Buffer.alloc(31).toString('base64'))).toBeNull();
    expect(decodeEncryptionKey('not base64 at all!')).toBeNull();
  });
});

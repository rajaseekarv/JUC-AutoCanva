import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalAssetStorage } from './asset-storage';

describe('LocalAssetStorage', () => {
  it('rejects storage keys that escape the configured root', async () => {
    const storage = new LocalAssetStorage();
    await expect(storage.remove('../outside-file')).rejects.toThrow(
      'Invalid asset storage key',
    );
  });

  // A backslash is a path separator only on Windows. On POSIX it is an
  // ordinary file-name character, so the same key names a file inside the
  // root, which does not exist.
  it('treats backslash keys by the platform path rules', async () => {
    const storage = new LocalAssetStorage();
    const backslashKey = storage.remove('..\\outside-file');
    if (process.platform === 'win32') {
      await expect(backslashKey).rejects.toThrow('Invalid asset storage key');
    } else {
      await expect(backslashKey).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

// Reads use a throwaway directory so the repository's asset storage is never
// touched. The root is fixed when the storage is constructed.
describe('LocalAssetStorage reads', () => {
  const previousDir = process.env.ASSET_STORAGE_DIR;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'adflow-asset-storage-'));
    process.env.ASSET_STORAGE_DIR = root;
  });

  afterAll(async () => {
    if (previousDir === undefined) delete process.env.ASSET_STORAGE_DIR;
    else process.env.ASSET_STORAGE_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });

  it('rejects a missing file before returning a stream', async () => {
    const storage = new LocalAssetStorage();
    await expect(storage.get('missing.png')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('streams the bytes of a stored file', async () => {
    await writeFile(join(root, 'present.png'), Buffer.from([1, 2, 3]));
    const storage = new LocalAssetStorage();
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get('present.png'))
      chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('still rejects keys that escape the root on read', async () => {
    const storage = new LocalAssetStorage();
    await expect(storage.get('../outside-file')).rejects.toThrow(
      'Invalid asset storage key',
    );
  });
});

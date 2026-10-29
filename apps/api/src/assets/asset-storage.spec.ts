import { describe, expect, it } from 'vitest';
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

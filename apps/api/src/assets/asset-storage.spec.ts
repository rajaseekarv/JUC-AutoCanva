import { describe, expect, it } from 'vitest';
import { LocalAssetStorage } from './asset-storage';

describe('LocalAssetStorage', () => {
  it('rejects storage keys that escape the configured root', async () => {
    const storage = new LocalAssetStorage();
    await expect(storage.remove('../outside-file')).rejects.toThrow(
      'Invalid asset storage key',
    );
    await expect(storage.remove('..\\outside-file')).rejects.toThrow(
      'Invalid asset storage key',
    );
  });
});

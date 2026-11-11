import { Injectable } from '@nestjs/common';
import { mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export const ASSET_STORAGE = Symbol('ASSET_STORAGE');

export interface AssetStorage {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

const repositoryRoot = resolve(__dirname, '../../../../');

function resolveAssetPath(root: string, key: string): string {
  const path = resolve(root, key);
  const pathFromRoot = relative(root, path);
  if (
    !pathFromRoot ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith('..' + sep) ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error('Invalid asset storage key');
  }
  return path;
}

@Injectable()
export class LocalAssetStorage implements AssetStorage {
  private readonly root = resolve(
    repositoryRoot,
    process.env.ASSET_STORAGE_DIR ?? '.local-storage/assets',
  );

  async put(key: string, content: Buffer): Promise<void> {
    const path = resolveAssetPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  }

  // Opening before streaming turns a missing file into a rejected promise the
  // caller can answer with 404, instead of an 'error' event on a piped stream.
  async get(key: string): Promise<Readable> {
    const file = await open(resolveAssetPath(this.root, key), 'r');
    return file.createReadStream();
  }

  async remove(key: string): Promise<void> {
    await unlink(resolveAssetPath(this.root, key));
  }
}

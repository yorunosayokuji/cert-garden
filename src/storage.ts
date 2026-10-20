import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { codes, CoreError } from './errors.ts';
import type { CoreState, StorageAdapter, StorageLoad } from './types.ts';
import { parseState } from './storageBase.ts';
export * from './storageBase.ts';

/** プロジェクト内のJSONファイル（ローカル検証用）。一時ファイル→rename で書込み途中の破損を避ける */
export class JsonFileStorage implements StorageAdapter {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load(): Promise<StorageLoad> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' };
      throw new CoreError(codes.corruptStorage, `保存ファイルを読めません: ${this.path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CoreError(codes.corruptStorage, `保存ファイルのJSONが壊れています（上書きしません）: ${this.path}`);
    }
    return { kind: 'ok', state: parseState(parsed) };
  }
  async save(state: CoreState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}

// 動きの画像を「選んだ個体のクリップだけ」準備し、準備が終わるまで時計を進めないための小さな仕組み（RNに依存しない）。
// 全26体の一斉先読みはしない。失敗は黙った空白にせず、呼び出し側が案内を出して再試行できる。

/**
 * Expo Asset から画像のURIを取り出す（Web/Native 共通）。localUri があればそれ、無ければ uri。
 * 空・文字列でない値は例外にする（空白の絵でごまかさない）。形は http(s)/file/データ/サーバー相対のいずれか。
 */
export function assetUriOf(asset: { uri?: unknown; localUri?: unknown }): string {
  const u = typeof asset.localUri === 'string' && asset.localUri ? asset.localUri : asset.uri;
  if (typeof u !== 'string' || !/^(https?:|file:|data:|blob:|\/)/.test(u)) throw new Error('画像のURIを解決できません');
  return u;
}

export class ClipLoadError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    super(`動きの画像を読み込めませんでした（${files.length}枚）`);
    this.name = 'ClipLoadError';
    this.files = files;
  }
}

export type FetchFile = (file: string) => Promise<boolean | void>;

export class ClipLoader {
  private readonly fetchFile: FetchFile;
  private readonly loaded = new Set<string>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(fetchFile: FetchFile) {
    this.fetchFile = fetchFile;
  }

  isReady(files: string[]): boolean {
    return files.every((f) => this.loaded.has(f));
  }

  private load(file: string): Promise<boolean> {
    if (this.loaded.has(file)) return Promise.resolve(true);
    const running = this.inflight.get(file);
    if (running) return running;
    const p = this.fetchFile(file).then(
      (ok) => {
        this.inflight.delete(file);
        if (ok === false) return false;
        this.loaded.add(file);
        return true;
      },
      () => {
        this.inflight.delete(file); // 失敗は覚えない（再試行できる）
        return false;
      },
    );
    this.inflight.set(file, p);
    return p;
  }

  /** 指定したファイルだけを準備する。同じファイルを同時に何度頼んでも1回だけ読む。1枚でも失敗したら ClipLoadError */
  async ensure(files: string[]): Promise<void> {
    const unique = [...new Set(files)];
    const results = await Promise.all(unique.map((f) => this.load(f)));
    const failed = unique.filter((_, i) => !results[i]);
    if (failed.length > 0) throw new ClipLoadError(failed);
  }

  /** 先に用意しておく（結果を待たず、失敗も表示を止めない） */
  warm(files: string[]): void {
    void this.ensure(files).catch(() => undefined);
  }
}

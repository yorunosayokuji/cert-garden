// Metro の require.context（画像の索引を実行時に引くため）。素材の一覧をコードに手書きしない。
interface NodeRequire {
  context(path: string, deep?: boolean, filter?: RegExp): { keys(): string[]; (id: string): number };
}

// 端末のキー値保存への薄い境界。AsyncStorage はここだけで参照し、試験ではメモリ版を使う。
export interface KeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export class MemoryKv implements KeyValue {
  readonly map = new Map<string, string>();
  failNextWrites = 0;
  async getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error('保存先に書き込めません');
    }
    this.map.set(key, value);
  }
  async removeItem(key: string) {
    this.map.delete(key);
  }
}

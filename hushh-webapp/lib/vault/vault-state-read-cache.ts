export type VaultStateRead<T> = {
  readonly key: string;
  readonly fresh: boolean;
  promise?: Promise<T>;
};

/** Memory-only metadata cache. Retired reads never restore an invalidated entry. */
export class VaultStateReadCache<T> {
  private readonly cached = new Map<string, { value: T; cachedAt: number }>();
  private readonly pending = new Map<string, VaultStateRead<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly staleTtlMs = ttlMs,
  ) {}

  getCached(key: string, options?: { allowStale?: boolean }): T | null {
    const entry = this.cached.get(key);
    if (!entry) return null;
    const ttl = options?.allowStale ? this.staleTtlMs : this.ttlMs;
    if (Date.now() - entry.cachedAt > ttl) {
      this.cached.delete(key);
      return null;
    }
    return entry.value;
  }

  getPending(key: string, forceFresh = false): Promise<T> | undefined {
    const read = this.pending.get(key);
    return read && (!forceFresh || read.fresh) ? read.promise : undefined;
  }

  begin(key: string, fresh: boolean): VaultStateRead<T> {
    if (fresh) this.cached.delete(key);
    const read = { key, fresh };
    this.pending.set(key, read);
    return read;
  }

  track(read: VaultStateRead<T>, promise: Promise<T>): void {
    read.promise = promise;
  }

  publish(read: VaultStateRead<T>, value: T): boolean {
    if (this.pending.get(read.key) !== read) return false;
    this.cached.set(read.key, { value, cachedAt: Date.now() });
    return true;
  }

  finish(read: VaultStateRead<T>): void {
    if (this.pending.get(read.key) === read) this.pending.delete(read.key);
  }

  invalidate(key?: string): void {
    if (key !== undefined) {
      this.cached.delete(key);
      this.pending.delete(key);
      return;
    }
    this.cached.clear();
    this.pending.clear();
  }
}

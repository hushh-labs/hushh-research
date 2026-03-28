export type HotGetJsonResult = {
  status: number;
  payload: unknown;
};

export function createHotGetJsonCache(params: {
  freshTtlMs: number;
  staleTtlMs: number;
}) {
  const cache = new Map<string, { status: number; payload: unknown; cachedAt: number }>();
  const inflight = new Map<string, Promise<HotGetJsonResult>>();

  function read(
    key: string,
    options?: { allowStale?: boolean }
  ): HotGetJsonResult | null {
    const cached = cache.get(key);
    if (!cached) return null;
    const ageMs = Date.now() - cached.cachedAt;
    const ttlMs = options?.allowStale ? params.staleTtlMs : params.freshTtlMs;
    if (ageMs > ttlMs) {
      cache.delete(key);
      return null;
    }
    return {
      status: cached.status,
      payload: cached.payload,
    };
  }

  function write(key: string, value: HotGetJsonResult): void {
    cache.set(key, {
      ...value,
      cachedAt: Date.now(),
    });
  }

  function getInflight(key: string): Promise<HotGetJsonResult> | null {
    return inflight.get(key) || null;
  }

  function setInflight(key: string, request: Promise<HotGetJsonResult>): void {
    inflight.set(key, request);
  }

  function clearInflight(key: string, request?: Promise<HotGetJsonResult>): void {
    const existing = inflight.get(key);
    if (!existing) return;
    if (!request || existing === request) {
      inflight.delete(key);
    }
  }

  return {
    read,
    write,
    getInflight,
    setInflight,
    clearInflight,
  };
}

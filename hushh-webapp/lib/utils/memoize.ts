type CacheKeyResolver<TArgs extends unknown[]> = (...args: TArgs) => string;

export interface MemoizeOptions<TArgs extends unknown[]> {
  maxSize?: number;
  keyResolver?: CacheKeyResolver<TArgs>;
}

function defaultKeyResolver<TArgs extends unknown[]>(...args: TArgs): string {
  return JSON.stringify(args);
}

export function memoize<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => TResult,
  options: MemoizeOptions<TArgs> = {}
): (...args: TArgs) => TResult {
  const { maxSize = 100, keyResolver = defaultKeyResolver } = options;
  const cache = new Map<string, TResult>();

  return (...args: TArgs): TResult => {
    const key = keyResolver(...args);

    if (cache.has(key)) {
      return cache.get(key) as TResult;
    }

    const result = fn(...args);
    cache.set(key, result);

    if (cache.size > maxSize) {
      const firstKey = cache.keys().next().value;

      if (firstKey) {
        cache.delete(firstKey);
      }
    }

    return result;
  };
}
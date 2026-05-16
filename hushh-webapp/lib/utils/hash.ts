function normalizeStableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    throw new TypeError("Unsupported value for stable hashing");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Unsupported non-finite number for stable hashing");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStableValue(item, seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("Unsupported circular value for stable hashing");
    }
    seen.add(value);
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = normalizeStableValue(
          (value as Record<string, unknown>)[key]
        );
        return acc;
      }, {});
  }

  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value));
}

export function createStableHash(value: unknown): string {
  const normalized = stableStringify(value);

  let hash = 0;

  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash << 5) - hash + normalized.charCodeAt(i);
    hash |= 0;
  }

  return hash.toString(16);
}

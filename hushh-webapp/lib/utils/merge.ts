function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  Object.entries(source).forEach(([key, value]) => {
    const existingValue = result[key];

    if (isPlainObject(existingValue) && isPlainObject(value)) {
      result[key] = deepMerge(existingValue, value);
    } else {
      result[key] = value;
    }
  });

  return result;
}

export function mergeMany(
  ...objects: Record<string, unknown>[]
): Record<string, unknown> {
  return objects.reduce<Record<string, unknown>>(
    (acc, obj) => deepMerge(acc, obj),
    {}
  );
}

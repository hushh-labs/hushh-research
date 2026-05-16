export function getNestedValue<T = unknown>(
  obj: unknown,
  path: string,
  fallback?: T
): T | undefined {
  if (!obj || typeof obj !== "object") {
    return fallback;
  }

  const keys = path.split(".");
  let result: any = obj;

  for (const key of keys) {
    if (result == null || typeof result !== "object") {
      return fallback;
    }
    result = result[key];
  }

  return result ?? fallback;
}

export function hasNestedKey(obj: unknown, path: string): boolean {
  if (!obj || typeof obj !== "object") return false;

  const keys = path.split(".");
  let current: any = obj;

  for (const key of keys) {
    if (current == null || typeof current !== "object") return false;
    if (!(key in current)) return false;
    current = current[key];
  }

  return true;
}

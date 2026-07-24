export function safeJsonParse<T = unknown>(
  value: string,
  fallback: T
): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function safeJsonStringify(
  value: unknown,
  fallback = ""
): string {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}
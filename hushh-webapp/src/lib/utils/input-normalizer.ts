export function normalizeInput<T extends Record<string, any>>(input: T): T {
  if (!input || typeof input !== "object") return input;

  const result: any = {};

  for (const key in input) {
    const value = input[key];

    result[key] =
      typeof value === "string" ? value.trim() : value;
  }

  return result;
}
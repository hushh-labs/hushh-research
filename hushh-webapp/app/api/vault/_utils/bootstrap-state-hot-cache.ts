import { createHotGetJsonCache } from "@/app/api/_utils/hot-get-json-cache";

export const bootstrapStateHotCache = createHotGetJsonCache({
  freshTtlMs: 30 * 1000,
  staleTtlMs: 5 * 60 * 1000,
});

export function invalidateBootstrapStateForUser(userId: string): void {
  const prefix = `${userId}:`;
  bootstrapStateHotCache.invalidate((key) => key.startsWith(prefix));
}

/** Availability-only retry policy for idempotent Vault reads. */
export const VAULT_READ_RETRY_DELAYS_MS = [2000, 5000, 10000] as const;

export function isRetryableVaultReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  if (failure.code === "AUTH_ACCOUNT_NOT_FOUND") return false;
  const nativeStatus = typeof failure.message === "string"
    ? /^(?:Failed to check vault: )?HTTP (\d{3})(?::|$)/.exec(failure.message)?.[1]
    : undefined;
  const status = typeof failure.status === "number" ? failure.status : Number(nativeStatus);
  if (Number.isFinite(status)) return status === 408 || status === 429 || (status >= 500 && status < 600);
  return failure.code === "DATABASE_UNAVAILABLE" || error instanceof TypeError || failure.name === "TimeoutError";
}

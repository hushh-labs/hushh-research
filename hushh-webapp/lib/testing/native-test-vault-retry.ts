import { resolveSlowRequestTimeoutMs } from "@/lib/utils/request-timeouts";

// Match the vault service's bounded slow-request policy. Local review runs
// intentionally use a UAT-backed Cloud SQL proxy, whose first request can
// exceed the production budget while connections warm; a shorter wrapper here
// used to mark that healthy request as a vault failure before the service's
// own retry policy could finish.
const NATIVE_TEST_VAULT_STEP_TIMEOUT_MS = resolveSlowRequestTimeoutMs(20_000);
const NATIVE_TEST_VAULT_MAX_ATTEMPTS = 5;
const NATIVE_TEST_VAULT_RETRY_DELAY_MS = 250;

export async function withVaultBootstrapTimeout<T>(
  label: string,
  operation: Promise<T>
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out`));
        }, NATIVE_TEST_VAULT_STEP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function isRetryableNativeTestVaultError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /network|failed to fetch|connection|timeout|timed out|502|503/.test(message);
}

/**
 * Retry only transient reads during the test-only vault admission handoff.
 *
 * The reviewer bootstrap runs while the Next shell and the local ADK proxy
 * are warming. A single failed read must not strand an otherwise valid
 * session, but authentication, vault-integrity, and setup-state failures must
 * remain terminal. The operation is supplied as a factory so each attempt
 * gets a fresh request and the final failure is still surfaced to the native
 * test bridge.
 */
export async function withNativeTestVaultRetry<T>(
  label: string,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= NATIVE_TEST_VAULT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await withVaultBootstrapTimeout(label, operation());
    } catch (error) {
      lastError = error;
      if (
        attempt >= NATIVE_TEST_VAULT_MAX_ATTEMPTS ||
        !isRetryableNativeTestVaultError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, NATIVE_TEST_VAULT_RETRY_DELAY_MS * attempt),
      );
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed`);
}


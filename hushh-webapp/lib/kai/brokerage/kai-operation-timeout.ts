const DEFAULT_KAI_STEP_TIMEOUT_MS = 90_000;

function parsePositiveTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  if (typeof raw !== "string") return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.round(parsed);
}

export const KAI_SAVE_STEP_TIMEOUT_MS = parsePositiveTimeoutMs(
  process.env.NEXT_PUBLIC_KAI_SAVE_STEP_TIMEOUT_MS,
  DEFAULT_KAI_STEP_TIMEOUT_MS,
);

export const KAI_AUXILIARY_STEP_TIMEOUT_MS = 20_000;

/**
 * Bound a user-visible Kai operation without pretending the underlying request
 * was cancelled. This is used at workflow seams where a slow secondary call
 * must not keep a completed Vault write in a loading state.
 */
export async function runKaiStepWithTimeout<T>(
  stepLabel: string,
  task: Promise<T>,
  timeoutMs: number = KAI_SAVE_STEP_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
      reject(
        new Error(
          `${stepLabel} is taking longer than expected (${timeoutSeconds}s). Please retry.`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

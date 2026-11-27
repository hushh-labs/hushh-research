/** Authored client feedback only; provider messages and response bodies are untrusted. */
export class FilesLocalError extends Error {}

export function isFilesWakingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "SANDBOX_WAKING" ||
    error.message === "POD_NOT_REACHED" ||
    /^(?:FILES_UNAVAILABLE|POD_DIRECT_UNAVAILABLE|ENDPOINT_UNAVAILABLE|POD_CHALLENGE_REFUSED|POD_ADMISSION_REFUSED):(?:502|503|504|SANDBOX_WAKING)$/.test(
      error.message,
    )
  );
}

export function transientFilesRead(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (isFilesWakingError(error)) return true;
  return (
    error instanceof Error &&
    /^(?:FILES_UNAVAILABLE|POD_DIRECT_UNAVAILABLE|ENDPOINT_UNAVAILABLE):429$/.test(
      error.message,
    )
  );
}

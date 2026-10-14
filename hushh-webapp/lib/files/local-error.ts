/** Authored client feedback only; provider messages and response bodies are untrusted. */
export class FilesLocalError extends Error {}

export function transientFilesRead(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof Error &&
    /^(?:FILES_UNAVAILABLE|POD_DIRECT_UNAVAILABLE|ENDPOINT_UNAVAILABLE):(429|502|503|504)$/.test(
      error.message,
    )
  );
}

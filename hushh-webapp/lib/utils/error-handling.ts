/**
 * Safe error message extraction utility
 * 
 * Safely extracts a human-readable error message from unknown error types.
 * Handles Error objects, strings, and other types.
 * 
 * @param error - The error caught in a try/catch block (typed as unknown)
 * @param defaultMessage - Default message if no message can be extracted
 * @returns A safe string error message
 * 
 * @example
 * try {
 *   // some code
 * } catch (err) {
 *   const message = getErrorMessage(err, "Something went wrong");
 *   toast.error(message);
 * }
 */
export function getErrorMessage(
  error: unknown,
  defaultMessage: string = "An unknown error occurred"
): string {
  // Handle Error objects
  if (error instanceof Error) {
    return error.message;
  }

  // Handle strings
  if (typeof error === "string") {
    return error;
  }

  // Handle objects with a message property
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }

  // Fallback to default message
  return defaultMessage;
}

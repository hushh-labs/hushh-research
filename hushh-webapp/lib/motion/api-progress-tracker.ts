/**
 * API progress tracking helpers.
 *
 * Tracking must never crash the application path that triggered it.
 */
export const TRACKING_DIAGNOSTIC_CONSOLE_MESSAGE =
  "[hushh:tracking] executeSafeTracking intercepted tracker failure";

export function trackRequestStart(): void {
  // Stub - can be extended to show loading indicator
}

export function trackRequestEnd(): void {
  // Stub - can be extended to hide loading indicator
}

export async function executeSafeTracking(
  trackingBlock: () => void | Promise<void>,
): Promise<boolean> {
  try {
    await trackingBlock();
    return true;
  } catch (error: unknown) {
    console.warn(TRACKING_DIAGNOSTIC_CONSOLE_MESSAGE, error);
    return false;
  }
}

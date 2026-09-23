import {
  isGoogleOAuthPopupSettlement,
  readGoogleOAuthPopupSettlement,
  type GoogleOAuthPopupAttempt,
  type GoogleOAuthPopupSettlement,
} from "@/lib/google/google-oauth-popup";

/** Only authored, non-provider messages are safe to show in connection feedback. */
export class GoogleOAuthPopupWaitError extends Error {}

/** One owner-bound wait; metadata is a display acknowledgement, not authority. */
export function waitForGoogleOAuthPopup(
  popup: Window,
  attempt: GoogleOAuthPopupAttempt,
  isCurrent: () => boolean,
  onFailure: () => void = () => undefined,
) {
  let cancel!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) onFailure();
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
      try {
        popup.close();
      } catch {
        // A detached window must not prevent listener cleanup or settlement.
      }
      if (error) reject(error);
      else resolve();
    };
    const receive = (value: GoogleOAuthPopupSettlement) => {
      if (
        value.attemptId !== attempt.attemptId ||
        value.service !== attempt.service ||
        !isCurrent()
      )
        return;
      finish(
        value.outcome === "succeeded"
          ? undefined
          : new GoogleOAuthPopupWaitError(
              value.outcome === "cancelled"
                ? "Drive connection was cancelled."
                : "Drive connection could not be confirmed. Check its status before trying again.",
            ),
      );
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.source === popup &&
        isGoogleOAuthPopupSettlement(event.data)
      )
        receive(event.data);
    };
    const onStorage = (event: StorageEvent) => {
      const value = readGoogleOAuthPopupSettlement(event);
      if (value) receive(value);
    };
    const timer = window.setInterval(() => {
      if (!isCurrent())
        finish(new DOMException("Connection session changed.", "AbortError"));
      else if (popup.closed || Date.now() - attempt.startedAt >= 5 * 60_000)
        finish(
          new GoogleOAuthPopupWaitError(
            "Drive connection was not confirmed. Check its status before trying again.",
          ),
        );
    }, 500);
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    cancel = () => finish(new DOMException("Connection closed.", "AbortError"));
  });
  // The caller may still be awaiting initiation when the popup is closed.
  void promise.catch(() => undefined);
  return { promise, cancel };
}

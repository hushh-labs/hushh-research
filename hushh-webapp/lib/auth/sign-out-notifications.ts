import type { User } from "firebase/auth";
import { getFCMSessionEpoch } from "@/lib/notifications/fcm-session";

const NOTIFICATION_CLEANUP_BUDGET_MS = 2_000;

/** Notifications are best effort; they cannot hold the auth teardown open. */
export async function settleSignOutNotifications(user: User): Promise<void> {
  const sessionEpoch = getFCMSessionEpoch();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      console.warn("Sign-out notification cleanup exceeded its time budget.");
      resolve();
    }, NOTIFICATION_CLEANUP_BUDGET_MS);
  });

  const cleanup = async () => {
    const idToken = await user.getIdToken();
    if (controller.signal.aborted) return;
    const { deleteFCMToken } = await import("@/lib/notifications/fcm-service");
    if (controller.signal.aborted) return;
    await deleteFCMToken(user.uid, idToken, { signal: controller.signal, sessionEpoch });
  };

  try {
    await Promise.race([cleanup(), expired]);
  } catch {
    console.warn("Sign-out notification cleanup failed (non-critical).");
  } finally {
    clearTimeout(timeout);
    // Fence late token/import/notification continuations after this operation.
    controller.abort();
  }
}

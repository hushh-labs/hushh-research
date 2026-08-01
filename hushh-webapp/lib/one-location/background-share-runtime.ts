import { HushhLocation, type BackgroundShareSession } from "@/lib/capacitor";

/**
 * Reconcile native background sharing with the current UI intent. We start only
 * when the user has opted in AND there is at least one publishable grant;
 * otherwise we stop. Idempotent — safe to call on every relevant change.
 */
export async function syncBackgroundShare(params: {
  enabled: boolean;
  session: BackgroundShareSession | null;
}): Promise<{ started: boolean; reason?: string }> {
  if (!params.enabled || !params.session || params.session.grants.length === 0) {
    await HushhLocation.stopBackgroundShare();
    return {
      started: false,
      reason: !params.enabled ? "disabled" : "no-active-grants",
    };
  }
  return HushhLocation.startBackgroundShare(params.session);
}

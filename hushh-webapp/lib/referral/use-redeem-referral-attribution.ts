"use client";

import { useEffect, useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  clearPendingAttribution,
  readPendingAttribution,
} from "@/lib/referral/pending-attribution";
import { ReferralService } from "@/lib/services/referral-service";

/**
 * Redeem a pending referral attribution once the person is signed in.
 *
 * This is the one place a referral relationship is created, and it runs on
 * entry to One rather than on the Referrals tab, because the person being
 * referred has no reason to ever open that tab.
 *
 * It is silent by design. Every outcome the server can return -- bound, already
 * referred, self-referral, expired, an account that predates the link -- is a
 * fact about attribution, not something the person did wrong, and none of them
 * should interrupt someone who is simply trying to use the app. The handle is
 * cleared either way: a failed redemption must not be retried forever, and a
 * successful one must not be redeemable twice.
 */
export function useRedeemReferralAttribution(): void {
  const { user, loading } = useAuth();

  // One attempt per session. Without this, any re-render of the gate re-fires
  // the redemption while the first request is still open.
  const attempted = useRef(false);

  useEffect(() => {
    if (loading || !user || attempted.current) return;

    const attributionId = readPendingAttribution();
    if (!attributionId) return;

    attempted.current = true;
    let cancelled = false;

    void (async () => {
      try {
        const idToken = await user.getIdToken();
        await ReferralService.bind({ idToken, attributionId });
      } catch {
        // A network failure here costs the referral, not the session. The
        // person continues into One exactly as they would have.
      } finally {
        if (!cancelled) clearPendingAttribution();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user]);
}

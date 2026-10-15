"use client";

import { useEffect } from "react";

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
 * cleared after a definitive response. Transient failures retain the opaque
 * attribution until successful redemption or its existing local expiry.
 */
export function useRedeemReferralAttribution(): void {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading || !user) return;
    let cancelled = false;
    let pending = false;
    const redeem = async () => {
      const attributionId = readPendingAttribution();
      if (cancelled || pending || !attributionId) return;
      pending = true;
      try {
        const idToken = await user.getIdToken();
        if (cancelled) return;
        const result = await ReferralService.bind({ idToken, attributionId });
        if (!cancelled && result.status !== "unavailable" && readPendingAttribution() === attributionId) clearPendingAttribution();
      } catch { /* Preserve the attribution through transient failures. */ }
      finally { pending = false; }
    };
    void redeem();
    const retry = () => { void redeem(); };
    window.addEventListener("online", retry);
    const timer = window.setInterval(retry, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("online", retry); };
  }, [loading, user]);
}

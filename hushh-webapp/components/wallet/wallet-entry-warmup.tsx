"use client";

import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { loadWalletCardArtwork } from "@/lib/services/wallet-card-artwork-service";

/** Prepare Wallet while its launcher is visible; never delay navigation. */
export function WalletEntryWarmup() {
  const { userId, loading, sessionVerificationRequired } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  useEffect(() => {
    for (const kind of ["profile", "referral", "nws"] as const) void loadWalletCardArtwork(kind).catch(() => {});
  }, []);
  useEffect(() => {
    if (!userId || loading || sessionVerificationRequired || !vaultKey || !vaultOwnerToken) return;
    let disposed = false;
    const warm = (force = false) => {
      if (disposed || document.visibilityState === "hidden") return;
      void import("@/lib/services/wallet-presentation-resource").then(({ WalletPresentationResource }) => {
        if (!disposed) return WalletPresentationResource.load({ userId, vaultKey, vaultOwnerToken }, { force });
        return undefined;
      }).catch(() => {});
    };
    warm();
    const visible = () => warm(true);
    const timer = window.setInterval(visible, 45_000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("focus", visible); document.removeEventListener("visibilitychange", visible); };
  }, [userId, loading, sessionVerificationRequired, vaultKey, vaultOwnerToken]);
  return null;
}

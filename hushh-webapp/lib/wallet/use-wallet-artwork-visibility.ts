"use client";

import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { WalletService, type WalletNetworkContext } from "@/lib/services/wallet-service";
import type { WalletArtworkReference } from "./card-artwork";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

/** Presentation authority is ephemeral; never mutate the owner's chosen design. */
export function useWalletArtworkVisibility(context: WalletNetworkContext | null, reference: WalletArtworkReference | undefined, active: boolean, purpose: "selection" | "saved" = "selection"): boolean {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const { userId, vaultOwnerToken } = context ?? {};
  const { assetId, issuerId, productId, variantId, digest, catalogVersion } = reference ?? {};
  const key = JSON.stringify([userId, vaultOwnerToken, epoch, assetId, issuerId, productId, variantId, digest, catalogVersion, purpose]);
  const [approval, setApproval] = useState<{ key: string; approved: boolean } | null>(null);
  useLayoutEffect(() => { setApproval(null); }, [active, key]);
  useEffect(() => {
    if (!active || !userId || !vaultOwnerToken || !assetId || !issuerId || !productId || !variantId || !digest || !catalogVersion) return;
    let generation = 0, operation: AbortController | null = null;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      const revision = ++generation, controller = new AbortController();
      operation?.abort(); operation = controller; setApproval(null);
      try {
        const approved = await WalletService.checkCardArtworkDisplay({ userId, vaultOwnerToken }, { assetId, issuerId, productId, variantId, digest, catalogVersion }, controller.signal, purpose);
        if (!controller.signal.aborted && generation === revision) setApproval({ key, approved });
      } catch {
        if (!controller.signal.aborted && generation === revision) setApproval({ key, approved: false });
      }
    };
    const resume = () => void check();
    resume();
    const timer = window.setInterval(resume, 60_000);
    window.addEventListener("focus", resume); document.addEventListener("visibilitychange", resume);
    return () => { generation++; operation?.abort(); window.clearInterval(timer); window.removeEventListener("focus", resume); document.removeEventListener("visibilitychange", resume); };
  }, [active, userId, vaultOwnerToken, epoch, assetId, issuerId, productId, variantId, digest, catalogVersion, purpose, key]);
  return !reference || Boolean(active && context && approval?.key === key && approval.approved);
}

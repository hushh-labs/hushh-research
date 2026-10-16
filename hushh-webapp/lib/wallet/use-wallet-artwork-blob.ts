"use client";

import { useLayoutEffect, useState } from "react";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { createWalletArtworkBlobUrl } from "./wallet-artwork-blob";

/** Blob URLs are display leases only: never persist or transmit them. */
export function useWalletArtworkBlob(image?: string, identity: unknown = image): string | null | undefined {
  const [lease, setLease] = useState<{ image: string; identity: unknown; url: string | null } | null>(null);
  useLayoutEffect(() => {
    if (!image) { setLease(null); return; }
    let url: string;
    try {
      url = createWalletArtworkBlobUrl(image);
    } catch { setLease({ image, identity, url: null }); return; }
    const owner = snapshotValidatedAuthSessionOwner();
    let revoked = false;
    const release = () => {
      if (revoked) return;
      revoked = true; URL.revokeObjectURL(url);
      setLease(current => current?.url === url ? null : current);
    };
    const verification = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!owner || !detail || (detail.userId === owner.userId && detail.generation === owner.generation)) release();
    };
    setLease({ image, identity, url });
    const unsubscribe = subscribeVaultSessionEpoch(release);
    window.addEventListener(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, verification);
    return () => { unsubscribe(); window.removeEventListener(AUTH_SESSION_VERIFICATION_REQUIRED_EVENT, verification); release(); };
  }, [image, identity]);
  return lease && lease.image === image && lease.identity === identity ? lease.url : undefined;
}

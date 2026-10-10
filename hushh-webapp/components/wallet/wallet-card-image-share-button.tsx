"use client";

import { useEffect, useMemo, useState } from "react";
import { Share2 } from "@/components/icons";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { shareFile } from "@/lib/share/share-file";
import { isShareCancellationError } from "@/lib/share/share-link";
import { createWalletCardImageFile, type WalletCardImageKind } from "@/lib/wallet/wallet-card-image";
import type { WalletDemoProfile } from "./wallet-demo-cards";

export function WalletCardImageShareButton({ cardId, profile, disabled = false }: {
  cardId: string; profile: WalletDemoProfile; disabled?: boolean;
}) {
  const kind: WalletCardImageKind = cardId === "agent-one-referral" ? "referral" : cardId === "agent-one-nws" ? "nws" : "profile";
  // Only face fields belong in the export. Never retain the rest of the profile.
  const identity = useMemo(() => ({
    ownerId: profile.ownerId, displayName: profile.displayName,
    cardPayload: { username: profile.cardPayload?.username },
    memberSince: profile.memberSince, walletId: profile.walletId,
    shareUrl: profile.shareUrl, referralUrl: profile.referralUrl,
  }), [profile.ownerId, profile.displayName, profile.cardPayload?.username, profile.memberSince, profile.walletId, profile.shareUrl, profile.referralUrl]);
  const key = JSON.stringify([kind, identity]);
  const [prepared, setPrepared] = useState<{ key: string; file: File | null; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    void createWalletCardImageFile({ kind, profile: identity, signal: controller.signal }).then(
      file => { if (!controller.signal.aborted) setPrepared({ key, file }); },
      () => { if (!controller.signal.aborted) setPrepared({ key, file: null, failed: true }); },
    );
    return () => controller.abort();
  }, [kind, identity, key, disabled, attempt]);
  const current = prepared?.key === key ? prepared : null;
  const failed = Boolean(current?.failed);
  const ready = current?.file;
  const share = async () => {
    if (disabled || sharing) return;
    if (failed) { setPrepared(null); setAttempt(value => value + 1); return; }
    if (!ready) return;
    setSharing(true);
    try {
      const outcome = await shareFile({ file: ready, title: `Agent One ${kind === "nws" ? "NWS" : kind === "referral" ? "Referral" : "Profile"}` });
      if (outcome === "download") morphyToast.success("Card image downloaded");
    } catch (error) {
      if (!isShareCancellationError(error)) morphyToast.error("Could not share the card. Try again.");
    } finally { setSharing(false); }
  };
  return <Button type="button" size="sm" className="min-h-11" variant="none" effect="fade" loading={sharing || (!disabled && !ready && !failed)} disabled={disabled || sharing || (!ready && !failed)} onClick={() => void share()}>
    <Share2 className="mr-2 h-4 w-4" aria-hidden />{failed ? "Retry card image" : "Share card"}
  </Button>;
}

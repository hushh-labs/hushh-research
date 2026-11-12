"use client";

import { useLayoutEffect, useEffect, useMemo, useRef, useState } from "react";
import { ProfilePaneShareIcon } from "@/components/profile/profile-pane-icons";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { withNativeFeedbackScope } from "@/lib/capacitor/native-feedback-sink";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { shareFile } from "@/lib/share/share-file";
import { isShareCancellationError } from "@/lib/share/share-link";
import { createWalletCardImageFile, type WalletCardImageKind } from "@/lib/wallet/wallet-card-image";
import type { WalletDemoProfile } from "./wallet-demo-cards";
import presentationStyles from "./wallet-connect-presentation.module.css";

export function useWalletCardImageShare({ cardId, profile, disabled = false, nativePresentation = false }: {
  cardId: string; profile: WalletDemoProfile; disabled?: boolean; nativePresentation?: boolean;
}) {
  const notify = (create: () => unknown) => nativePresentation ? withNativeFeedbackScope("workspace", create) : create();
  const kind: WalletCardImageKind = cardId === "agent-one-referral" ? "referral" : cardId === "agent-one-nws" ? "nws" : "profile";
  // Only face fields belong in the export. Never retain the rest of the profile.
  const identity = useMemo(() => ({
    ownerId: profile.ownerId, displayName: profile.displayName,
    cardPayload: { full_name: profile.cardPayload?.full_name },
    memberSince: profile.memberSince, walletId: profile.walletId,
    shareUrl: profile.shareUrl, referralUrl: profile.referralUrl,
  }), [profile.ownerId, profile.displayName, profile.cardPayload?.full_name, profile.memberSince, profile.walletId, profile.shareUrl, profile.referralUrl]);
  const key = JSON.stringify([kind, identity]);
  const lease = useMemo(() => ({ active: true, key, disabled }), [key, disabled]);
  const currentLease = useRef(lease);
  useLayoutEffect(() => { currentLease.current = lease; });
  useEffect(() => {
    lease.active = true;
    setSharing(false);
    return () => { lease.active = false; };
  }, [lease]);
  const [prepared, setPrepared] = useState<{ key: string; file: File | null; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    if (disabled) { setPrepared(null); return; }
    const controller = new AbortController();
    void createWalletCardImageFile({ kind, profile: identity, signal: controller.signal }).then(
      file => { if (!controller.signal.aborted) setPrepared({ key, file }); },
      () => { if (!controller.signal.aborted) setPrepared({ key, file: null, failed: true }); },
    );
    return () => controller.abort();
  }, [kind, identity, key, disabled, attempt]);
  const current = !disabled && prepared?.key === key ? prepared : null;
  const failed = Boolean(current?.failed);
  const ready = current?.file;
  const share = async (workspaceChoice?: NativeWorkspaceChoice) => {
    if (disabled || sharing) return;
    if (failed) { setPrepared(null); setAttempt(value => value + 1); return; }
    if (!ready) return;
    setSharing(true);
    const isEffectCurrent = () => lease.active && currentLease.current === lease && !disabled;
    try {
      const outcome = await shareFile({ file: ready, isEffectCurrent, ...(workspaceChoice ? { workspaceChoice } : {}), title: `Agent One ${kind === "nws" ? "NWS" : kind === "referral" ? "Referral" : "Profile"}` });
      if (isEffectCurrent() && outcome === "download") notify(() => morphyToast.success("Card image downloaded"));
    } catch (error) {
      if (isEffectCurrent() && !isShareCancellationError(error)) notify(() => morphyToast.error("Could not share the card. Try again."));
    } finally { if (isEffectCurrent()) setSharing(false); }
  };
  return { share, sharing, ready, failed };
}
export function WalletCardImageShareButton(props: Parameters<typeof useWalletCardImageShare>[0]) {
  const { disabled = false } = props;
  const { share, sharing, ready, failed } = useWalletCardImageShare(props);
  return <Button type="button" size="compact" className={presentationStyles.quietAction} variant="none" effect="fade" loading={sharing || (!disabled && !ready && !failed)} disabled={disabled || sharing || (!ready && !failed)} onClick={() => void share()}>
    <ProfilePaneShareIcon className="mr-2 h-4 w-4" aria-hidden />{failed ? "Retry card image" : "Share card"}
  </Button>;
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ProfilePaneCopyIcon } from "@/components/profile/profile-pane-icons";
import { AppleWalletIcon } from "@/components/wallet/apple-wallet-icon";
import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import presentationStyles from "./wallet-connect-presentation.module.css";
import { WalletCardQrActions } from "@/components/wallet-card/wallet-card-qr-actions";
import { WalletCardQr } from "@/components/wallet-card/wallet-card-qr";
import {
  copyWalletCardLink,
} from "@/components/wallet-card/wallet-card-share";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import type { ReferralSummary } from "@/lib/services/referral-service";
import { WalletCardService } from "@/lib/services/wallet-card-service";
import { WalletCardImageShareButton } from "./wallet-card-image-share-button";
import type { WalletDemoProfile } from "./wallet-demo-cards";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { WalletCardConfirmDialog } from "@/components/wallet-card/wallet-card-confirm-dialog";

/** Uses the same referral authority and live summary as the wallet card face. */
export type WalletReferralDetailsProps = {
  summary: ReferralSummary | null;
  shareToken: string | null;
  profile?: WalletDemoProfile | null;
  failed?: boolean;
  onRetry?: () => void;
  onRevoke?: (slug: string) => Promise<void>;
};

export function useWalletReferralOwner({
  summary,
  shareToken,
  profile,
  onRevoke,
}: WalletReferralDetailsProps) {
  const [busy, setBusy] = useState<"wallet" | "revoke" | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const visit = useMemo(() => ({ ownerId: profile?.ownerId, onRevoke }), [profile?.ownerId, onRevoke]);
  const visitRef = useRef<object | null>(visit);
  visitRef.current = visit;
  useEffect(() => { visitRef.current = visit; setBusy(null); setConfirmRevoke(false); return () => { if (visitRef.current === visit) visitRef.current = null; }; }, [visit]);

  const addToWallet = async () => {
    if (!shareToken) return;
    setBusy("wallet");
    try {
      const result = await WalletCardService.addToAppleWallet(shareToken, { variant: "referral" });
      if (visitRef.current === visit && result.state !== "opened") morphyToast.error(result.message);
    } catch {
      if (visitRef.current === visit) morphyToast.error("Could not create your pass. Try again.");
    } finally {
      if (visitRef.current === visit) setBusy(null);
    }
  };

  const revokeAccess = async () => {
    if (!summary || !onRevoke || busy) return;
    setBusy("revoke");
    try {
      await onRevoke(summary.slug);
      if (visitRef.current !== visit) return;
      setConfirmRevoke(false);
      morphyToast.success("Old referral QR revoked. Your new link starts with zero opens.");
    } catch {
      if (visitRef.current === visit) morphyToast.error("Could not revoke access. Try again.");
    } finally {
      if (visitRef.current === visit) setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!summary) return;
    const copied = await copyWalletCardLink(summary.link);
    if (visitRef.current === visit) copied ? morphyToast.success("Link copied") : morphyToast.error("Could not copy");
  };
  return { busy, confirmRevoke, setConfirmRevoke, addToWallet, revokeAccess, copyLink };
}

export function WalletReferralCardDetails(props: WalletReferralDetailsProps) {
  const { summary, shareToken, profile, failed = false, onRetry, onRevoke } = props;
  const { busy, confirmRevoke, setConfirmRevoke, addToWallet, revokeAccess, copyLink } = useWalletReferralOwner(props);
  if (!summary) {
    return <div className="space-y-3 py-6">
      <p role={failed ? "alert" : "status"} className="text-[13px] leading-[18px] font-semibold text-muted-foreground">{failed ? "Your referral card could not be loaded." : "Your referral card is loading."}</p>
      {failed && onRetry ? <Button type="button" variant="none" effect="fade" size="compact" className={presentationStyles.quietAction} onClick={onRetry}>Try again</Button> : null}
    </div>;
  }

  return (
    <SettingsPresentationProvider separatorInset density="compact">
    <section aria-label="Referral card details" className={`${profileStyles.walletContent} ${presentationStyles.walletSurface} space-y-4`}>
      <SettingsGroup title="Your referral QR">
        <WalletCardQrActions qr={<WalletCardQr value={summary.link} label="Your referral QR code" />}>
            <Button type="button" size="sm" className="min-h-11 text-[13px]" loading={busy === "wallet"} disabled={!shareToken || Boolean(busy)} onClick={() => void addToWallet()}>
              <AppleWalletIcon />Add to Apple Wallet
            </Button>
            <WalletCardImageShareButton cardId="agent-one-referral" profile={{ ...profile, displayName: profile?.displayName ?? null, shareUrl: profile?.shareUrl ?? null, referralUrl: summary.link }} disabled={!profile || Boolean(busy)} />
            <Button type="button" size="compact" className={presentationStyles.quietAction} variant="none" effect="fade" onClick={() => void copyLink()}>
              <ProfilePaneCopyIcon className="mr-2 h-4 w-4" aria-hidden />Copy link
            </Button>
            <Button type="button" size="sm" className="min-h-11 text-[13px]" variant="destructive" effect="fade" disabled={!onRevoke || Boolean(busy)} onClick={() => setConfirmRevoke(true)}>Revoke access</Button>
          <a href={summary.link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-[13px] text-primary underline-offset-4 hover:underline">Preview referral page</a>
        </WalletCardQrActions>
      </SettingsGroup>
      <SettingsGroup title="Referral activity">
        <SettingsRow density="compact" title="Link opens" trailing={<span data-testid="wallet-referral-opens">{summary.link_open_count?.toLocaleString() ?? "—"}</span>} />
        <SettingsRow density="compact" title="Last opened" trailing={<span className="text-right text-xs text-muted-foreground">{formatLocalDateTime(summary.last_opened_at ?? null) || "No opens yet"}</span>} />
        <SettingsRow density="compact" title="Qualified referrals" trailing={<span>{summary.qualified_count.toLocaleString()}</span>} />
        <SettingsRow density="compact" title="In progress" trailing={<span>{summary.in_progress_count.toLocaleString()}</span>} />
        <SettingsRow density="compact" title="Under review" trailing={<span>{summary.under_review_count.toLocaleString()}</span>} />
      </SettingsGroup>
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">Opens include QR scans and links, not unique visitors. Progress updates automatically.</p>
      {summary.referrals.length ? (
        <SettingsGroup title="Recent referrals">
          {summary.referrals.map((referral, index) => (
            <SettingsRow key={`${referral.started_on}-${index}`} density="compact" title={referral.status} description={referral.step} trailing={<span className="text-xs text-muted-foreground">{referral.started_on}</span>} />
          ))}
        </SettingsGroup>
      ) : null}
      <WalletCardConfirmDialog
        open={confirmRevoke}
        title="Revoke referral QR access?"
        body="Replace the referral QR and reset opens; earned referrals stay."
        confirmLabel="Revoke access"
        destructive
        busy={busy !== null}
        onConfirm={() => void revokeAccess()}
        onOpenChange={setConfirmRevoke}
      />
    </section>
    </SettingsPresentationProvider>
  );
}

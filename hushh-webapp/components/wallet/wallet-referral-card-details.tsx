"use client";

import { useState } from "react";
import { Copy, Wallet } from "@/components/icons";
import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import profileStyles from "@/components/profile/profile-your-account.module.css";
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

/** Uses the same referral authority and live summary as the wallet card face. */
export function WalletReferralCardDetails({
  summary,
  shareToken,
  profile,
  failed = false,
  onRetry,
}: {
  summary: ReferralSummary | null;
  shareToken: string | null;
  profile?: WalletDemoProfile | null;
  failed?: boolean;
  onRetry?: () => void;
}) {
  const [busy, setBusy] = useState<"wallet" | null>(null);
  if (!summary) {
    return <div className="space-y-3 py-6">
      <p role={failed ? "alert" : "status"} className="text-sm text-muted-foreground">{failed ? "Your referral card could not be loaded." : "Your referral card is loading."}</p>
      {failed && onRetry ? <Button type="button" size="sm" onClick={onRetry}>Try again</Button> : null}
    </div>;
  }

  const addToWallet = async () => {
    if (!shareToken) return;
    setBusy("wallet");
    try {
      const result = await WalletCardService.addToAppleWallet(shareToken, { variant: "referral" });
      if (result.state !== "opened") morphyToast.error(result.message);
    } catch {
      morphyToast.error("Could not create your pass. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsPresentationProvider separatorInset density="compact">
    <section aria-label="Referral card details" className={`${profileStyles.walletContent} space-y-4`}>
      <SettingsGroup title="Your referral QR">
        <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
          <div className="mx-auto w-full max-w-[220px]">
            <WalletCardQr value={summary.link} label="Your referral QR code" />
          </div>
          <p className="break-all rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{summary.link}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="min-h-11" loading={busy === "wallet"} disabled={!shareToken} onClick={() => void addToWallet()}>
              <Wallet className="mr-2 h-4 w-4" aria-hidden />Add to Apple Wallet
            </Button>
            <WalletCardImageShareButton cardId="agent-one-referral" profile={{ ...profile, displayName: profile?.displayName ?? null, shareUrl: profile?.shareUrl ?? null, referralUrl: summary.link }} disabled={!profile || Boolean(busy)} />
            <Button type="button" size="sm" className="min-h-11" variant="none" effect="fade" onClick={() => void copyWalletCardLink(summary.link).then((copied) => copied ? morphyToast.success("Link copied") : morphyToast.error("Could not copy"))}>
              <Copy className="mr-2 h-4 w-4" aria-hidden />Copy link
            </Button>
          </div>
          <a href={summary.link} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">Preview referral page</a>
        </div>
      </SettingsGroup>
      <SettingsGroup title="Referral activity">
        <SettingsRow density="compact" title="Link opens" trailing={<span>{summary.link_open_count?.toLocaleString() ?? "—"}</span>} />
        <SettingsRow density="compact" title="Last opened" trailing={<span className="text-right text-xs text-muted-foreground">{formatLocalDateTime(summary.last_opened_at ?? null) || "No opens yet"}</span>} />
        <SettingsRow density="compact" title="Qualified referrals" trailing={<span>{summary.qualified_count.toLocaleString()}</span>} />
        <SettingsRow density="compact" title="In progress" trailing={<span>{summary.in_progress_count.toLocaleString()}</span>} />
        <SettingsRow density="compact" title="Under review" trailing={<span>{summary.under_review_count.toLocaleString()}</span>} />
      </SettingsGroup>
      <p className="px-1 text-xs leading-relaxed text-muted-foreground">Link opens include QR visits and shared links. They are not unique visitors. Referral progress updates automatically.</p>
      {summary.referrals.length ? (
        <SettingsGroup title="Recent referrals">
          {summary.referrals.map((referral, index) => (
            <SettingsRow key={`${referral.started_on}-${index}`} density="compact" title={referral.status} description={referral.step} trailing={<span className="text-xs text-muted-foreground">{referral.started_on}</span>} />
          ))}
        </SettingsGroup>
      ) : null}
    </section>
    </SettingsPresentationProvider>
  );
}

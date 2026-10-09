"use client";

import type { ReactNode } from "react";
import { Copy, Link2, Share2, Wallet } from "@/components/icons";
import {
  ProfilePaneDeleteIcon,
  ProfilePaneEditIcon,
  ProfilePanePauseIcon,
  ProfilePanePreviewIcon,
  ProfilePaneResumeIcon,
  ProfilePaneRotateIcon,
  ProfilePaneWalletIcon,
  ProfilePaneScanIcon,
  ProfilePaneHistoryIcon,
} from "@/components/profile/profile-pane-icons";

import { SettingsGroup, SettingsPresentationProvider, SettingsRow } from "@/components/profile/settings-ui";
import { RowDescription } from "@/components/app-ui/typography";
import profileStyles from "@/components/profile/profile-your-account.module.css";
import { Button } from "@/lib/morphy-ux/morphy";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { WALLET_CARD_OWNER_COPY } from "@/components/wallet-card/wallet-card-copy";
import { WalletCardQr } from "@/components/wallet-card/wallet-card-qr";
import type {
  WalletCardRecord,
  WalletCardShareLink,
} from "@/lib/services/wallet-card-service";

export type WalletCardManageAction =
  | "preview"
  | "edit"
  | "pause"
  | "resume"
  | "rotate"
  | "remove"
  | "add-to-wallet"
  | "share"
  | "copy";

/**
 * The management surface shown once a Wallet Profile exists.
 *
 * Every entry answers "what do people see when they scan?" — the live QR, when
 * the shared information last changed, and one control per way of changing or
 * stopping that. Each destructive control routes through a confirmation that
 * states the effect first.
 */
export function WalletCardManage({
  card,
  shareLink,
  applePassSupported,
  busyAction,
  onAction,
  shareAction,
}: {
  card: WalletCardRecord;
  shareLink: WalletCardShareLink | null;
  applePassSupported: boolean;
  busyAction: WalletCardManageAction | null;
  onAction: (action: WalletCardManageAction) => void;
  shareAction?: ReactNode;
}) {
  const paused = card.status === "paused";
  const lastUpdated = formatLocalDateTime(card.updatedAt);
  const lastScanned = formatLocalDateTime(card.lastScannedAt);

  return (
    <SettingsPresentationProvider separatorInset density="compact">
    <div className={`${profileStyles.walletContent} space-y-4`}>
      <SettingsGroup>
        <SettingsRow
          icon={paused ? ProfilePanePauseIcon : ProfilePaneWalletIcon}
          iconTone="capability"
          title={
            paused
              ? WALLET_CARD_OWNER_COPY.statusPaused
              : WALLET_CARD_OWNER_COPY.statusActive
          }
          description={
            paused
              ? WALLET_CARD_OWNER_COPY.statusPausedDetail
              : WALLET_CARD_OWNER_COPY.updatesAutomatically
          }
        />
        {lastUpdated ? (
          <SettingsRow
            icon={ProfilePaneEditIcon}
            iconTone="capability"
            density="compact"
            title={WALLET_CARD_OWNER_COPY.lastUpdatedLabel}
            trailing={<span>{lastUpdated}</span>}
            stackTrailingOnMobile
          />
        ) : null}
        <SettingsRow
          icon={ProfilePaneScanIcon}
          iconTone="capability"
          density="compact"
          title={WALLET_CARD_OWNER_COPY.scanCountLabel}
          trailing={<span>{card.scanCount.toLocaleString()}</span>}
        />
        {lastScanned ? (
          <SettingsRow
            icon={ProfilePaneHistoryIcon}
            iconTone="capability"
            density="compact"
            title={WALLET_CARD_OWNER_COPY.lastScannedLabel}
            trailing={<span>{lastScanned}</span>}
            stackTrailingOnMobile
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Your QR">
        {shareLink ? (
          <div className="space-y-4 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="mx-auto w-full max-w-[220px]">
              <WalletCardQr
                value={shareLink.shareUrl}
                label="Your Wallet Profile QR code"
              />
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-muted/40 px-3 py-2">
              <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <RowDescription as="span" compact className="min-w-0 flex-1 truncate">
                {shareLink.shareUrl}
              </RowDescription>
            </div>
            {applePassSupported ? null : (
              <RowDescription compact>
                {WALLET_CARD_OWNER_COPY.addOnIphoneHint}
              </RowDescription>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                loading={busyAction === "add-to-wallet"}
                onClick={() => onAction("add-to-wallet")}
              >
                <Wallet className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.addToWallet}
              </Button>
              {shareAction ?? <Button
                type="button"
                size="sm"
                className="min-h-11"
                variant="none"
                effect="fade"
                loading={busyAction === "share"}
                onClick={() => onAction("share")}
              >
                <Share2 className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.shareLink}
              </Button>}
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                variant="none"
                effect="fade"
                onClick={() => onAction("copy")}
              >
                <Copy className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.copyLink}
              </Button>
            </div>
          </div>
        ) : (
          <RowDescription compact className="px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            {WALLET_CARD_OWNER_COPY.noLinkOnThisDevice}
          </RowDescription>
        )}
      </SettingsGroup>

      <SettingsGroup title="Sharing controls" rowSizing="uniform">
        <SettingsRow
          icon={ProfilePanePreviewIcon}
          iconTone="capability"
          title={WALLET_CARD_OWNER_COPY.previewAsVisitor}
          description="See exactly what a scan shows right now."
          chevron
          onClick={() => onAction("preview")}
        />
        <SettingsRow
          icon={ProfilePaneEditIcon}
          iconTone="capability"
          title={WALLET_CARD_OWNER_COPY.editInformation}
          description="Change what is included. Your QR stays the same."
          chevron
          onClick={() => onAction("edit")}
        />
        <SettingsRow
          icon={paused ? ProfilePaneResumeIcon : ProfilePanePauseIcon}
          iconTone="capability"
          title={
            paused
              ? WALLET_CARD_OWNER_COPY.resumeSharing
              : WALLET_CARD_OWNER_COPY.pauseSharing
          }
          description={
            paused
              ? "Make your selected information visible again."
              : "A scan will show nothing until you resume."
          }
          chevron
          disabled={busyAction === "pause" || busyAction === "resume"}
          onClick={() => onAction(paused ? "resume" : "pause")}
        />
        <SettingsRow
          icon={ProfilePaneRotateIcon}
          iconTone="capability"
          title={WALLET_CARD_OWNER_COPY.rotateAccess}
          description="Invalidate the current QR and create a new one."
          chevron
          disabled={busyAction === "rotate"}
          onClick={() => onAction("rotate")}
        />
        <SettingsRow
          icon={ProfilePaneDeleteIcon}
          iconTone="capability"
          tone="destructive"
          className="profile-account-delete-row"
          title={WALLET_CARD_OWNER_COPY.removeProfile}
          description="Stop sharing and take the profile down for good."
          chevron
          disabled={busyAction === "remove"}
          onClick={() => onAction("remove")}
        />
      </SettingsGroup>
    </div>
    </SettingsPresentationProvider>
  );
}

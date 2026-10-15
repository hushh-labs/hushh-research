"use client";

import { AppleWalletIcon } from "@/components/wallet/apple-wallet-icon";
import type { ReactNode } from "react";
import {
  ProfilePaneCopyIcon,
  ProfilePaneShareIcon,
  ProfilePaneDeleteIcon,
  ProfilePaneEditIcon,
  ProfilePanePauseIcon,
  ProfilePanePreviewIcon,
  ProfilePaneResumeIcon,
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
import { WalletCardQrActions } from "./wallet-card-qr-actions";
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
          trailing={<span data-testid="wallet-profile-scans">{card.scanCount.toLocaleString()}</span>}
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
        <WalletCardQrActions qr={shareLink ? (
          <WalletCardQr value={shareLink.shareUrl} label="Your Wallet Profile QR code" />
        ) : <RowDescription compact>{WALLET_CARD_OWNER_COPY.noLinkOnThisDevice}</RowDescription>}>
              <Button
                type="button"
                size="sm"
                className="min-h-11 text-[13px]"
                disabled={!shareLink}
                loading={busyAction === "add-to-wallet"}
                onClick={() => onAction("add-to-wallet")}
              >
                <AppleWalletIcon />
                {WALLET_CARD_OWNER_COPY.addToWallet}
              </Button>
              {shareAction ?? <Button
                type="button"
                size="sm"
                className="min-h-11 text-[13px]"
                variant="none"
                effect="fade"
                disabled={!shareLink}
                loading={busyAction === "share"}
                onClick={() => onAction("share")}
              >
                <ProfilePaneShareIcon className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.shareLink}
              </Button>}
              <Button
                type="button"
                size="sm"
                className="min-h-11 text-[13px]"
                variant="none"
                effect="fade"
                disabled={!shareLink}
                onClick={() => onAction("copy")}
              >
                <ProfilePaneCopyIcon className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.copyLink}
              </Button>
              <Button
                type="button"
                size="sm"
                className="min-h-11 text-[13px]"
                variant="none"
                effect="fade"
                disabled={busyAction !== null}
                onClick={() => onAction("rotate")}
              >
                {WALLET_CARD_OWNER_COPY.revokeAccess}
              </Button>
        </WalletCardQrActions>
      </SettingsGroup>

      <SettingsGroup title="Sharing controls" rowSizing="uniform">
        <SettingsRow
          icon={ProfilePanePreviewIcon}
          iconTone="capability"
          title={WALLET_CARD_OWNER_COPY.previewAsVisitor}
          chevron
          onClick={() => onAction("preview")}
        />
        <SettingsRow
          icon={ProfilePaneEditIcon}
          iconTone="capability"
          title={WALLET_CARD_OWNER_COPY.editInformation}
          description="Your QR stays the same."
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
              ? "Show your selected information."
              : "Hide until you resume."
          }
          chevron
          disabled={busyAction === "pause" || busyAction === "resume"}
          onClick={() => onAction(paused ? "resume" : "pause")}
        />
        <SettingsRow
          icon={ProfilePaneDeleteIcon}
          iconTone="capability"
          tone="destructive"
          className="profile-account-delete-row"
          title={WALLET_CARD_OWNER_COPY.removeProfile}
          description="Stops sharing. Can't be undone."
          chevron
          disabled={busyAction === "remove"}
          onClick={() => onAction("remove")}
        />
      </SettingsGroup>
    </div>
    </SettingsPresentationProvider>
  );
}

"use client";

import {
  Copy,
  Eye,
  Link2,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Share2,
  Trash2,
  Wallet,
} from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
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
}: {
  card: WalletCardRecord;
  shareLink: WalletCardShareLink | null;
  applePassSupported: boolean;
  busyAction: WalletCardManageAction | null;
  onAction: (action: WalletCardManageAction) => void;
}) {
  const paused = card.status === "paused";
  const lastUpdated = formatLocalDateTime(card.updatedAt);
  const lastScanned = formatLocalDateTime(card.lastScannedAt);

  return (
    <div className="space-y-4">
      <SettingsGroup>
        <SettingsRow
          icon={paused ? Pause : Wallet}
          iconTone={paused ? "orange" : "green"}
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
            density="compact"
            title={WALLET_CARD_OWNER_COPY.lastUpdatedLabel}
            trailing={
              <span className="text-[13px] text-muted-foreground">{lastUpdated}</span>
            }
          />
        ) : null}
        <SettingsRow
          density="compact"
          title={WALLET_CARD_OWNER_COPY.scanCountLabel}
          trailing={
            <span className="text-[13px] text-muted-foreground">
              {card.scanCount.toLocaleString()}
            </span>
          }
        />
        {lastScanned ? (
          <SettingsRow
            density="compact"
            title={WALLET_CARD_OWNER_COPY.lastScannedLabel}
            trailing={
              <span className="text-[13px] text-muted-foreground">{lastScanned}</span>
            }
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
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                {shareLink.shareUrl}
              </span>
            </div>
            {applePassSupported ? null : (
              <p className="text-[12px] text-muted-foreground">
                {WALLET_CARD_OWNER_COPY.addOnIphoneHint}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                loading={busyAction === "add-to-wallet"}
                onClick={() => onAction("add-to-wallet")}
              >
                <Wallet className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.addToWallet}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="none"
                effect="fade"
                loading={busyAction === "share"}
                onClick={() => onAction("share")}
              >
                <Share2 className="mr-2 h-4 w-4" aria-hidden />
                {WALLET_CARD_OWNER_COPY.shareLink}
              </Button>
              <Button
                type="button"
                size="sm"
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
          <div className="px-[var(--settings-row-px)] py-[var(--settings-row-py)] text-[12.5px] leading-[1.5] text-muted-foreground">
            {WALLET_CARD_OWNER_COPY.noLinkOnThisDevice}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup title="Sharing controls">
        <SettingsRow
          icon={Eye}
          iconTone="blue"
          title={WALLET_CARD_OWNER_COPY.previewAsVisitor}
          description="See exactly what a scan shows right now."
          chevron
          onClick={() => onAction("preview")}
        />
        <SettingsRow
          icon={Pencil}
          iconTone="accent"
          title={WALLET_CARD_OWNER_COPY.editInformation}
          description="Change what is included. Your QR stays the same."
          chevron
          onClick={() => onAction("edit")}
        />
        <SettingsRow
          icon={paused ? Play : Pause}
          iconTone="orange"
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
          icon={RefreshCw}
          iconTone="purple"
          title={WALLET_CARD_OWNER_COPY.rotateAccess}
          description="Invalidate the current QR and create a new one."
          chevron
          disabled={busyAction === "rotate"}
          onClick={() => onAction("rotate")}
        />
        <SettingsRow
          icon={Trash2}
          tone="destructive"
          title={WALLET_CARD_OWNER_COPY.removeProfile}
          description="Stop sharing and take the profile down for good."
          chevron
          disabled={busyAction === "remove"}
          onClick={() => onAction("remove")}
        />
      </SettingsGroup>
    </div>
  );
}

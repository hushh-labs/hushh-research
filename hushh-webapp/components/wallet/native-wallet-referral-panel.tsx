"use client";

import { useLayoutEffect } from "react";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { openExternalUrl } from "@/lib/utils/browser-navigation";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { useWalletReferralOwner, type WalletReferralDetailsProps } from "./wallet-referral-card-details";
import { useWalletCardImageShare } from "./wallet-card-image-share-button";
import { useNativeWalletImages } from "./use-native-wallet-images";
import type { WalletPanelProjection } from "./native-wallet-payment-panel";

export function NativeWalletReferralPanel({ handle, publish, onClose, ...props }: WalletReferralDetailsProps & {
  handle: (key: string) => string; publish: (value: WalletPanelProjection) => void; onClose: () => void;
}) {
  const model = useWalletReferralOwner(props);
  const sharing = useWalletCardImageShare({ cardId: "agent-one-referral", profile: { ...props.profile, displayName: props.profile?.displayName ?? null, shareUrl: props.profile?.shareUrl ?? null, referralUrl: props.summary?.link ?? null }, disabled: !props.profile || !props.summary || !!model.busy });
  const images = useNativeWalletImages(props.summary?.link, sharing.ready);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const sections: NativeDrawerSection[] = [];
  const busy = !!model.busy || sharing.sharing;
  const row = (key: string, label: string, action?: () => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handle(key); if (action) actions.set(id, action);
    return { id, label, enabled: !busy, ...(!action ? { readOnly: true } : {}), ...extra };
  };
  const group = (key: string, rows: NativeDrawerRow[], title?: string) => sections.push({ id: handle(`section-${key}`), ...(title ? { title } : {}), rows });
  let title = "Referral";
  if (model.confirmRevoke) {
    title = "Revoke referral QR access?";
    group("confirm", [row("confirm-note", "Replace the referral QR and reset opens; earned referrals stay."), row("revoke", "Revoke access", model.revokeAccess, { destructive: true }), row("keep", "Keep access", () => model.setConfirmRevoke(false))]);
  } else if (!props.summary) {
    group("status", [row("status", props.failed ? "Your referral card could not be loaded." : "Your referral card is loading."), ...(props.failed && props.onRetry ? [row("retry", "Try again", props.onRetry)] : [])]);
  } else {
    const summary = props.summary;
    group("actions", [row("apple-wallet", "Add to Apple Wallet", model.addToWallet, { enabled: !busy && !!props.shareToken, artworkId: "account-wallet" }),
      row("share", sharing.failed ? "Retry card image" : "Share card", sharing.share, { enabled: !busy && !!(sharing.ready || sharing.failed), artworkId: "invite" }),
      row("copy", "Copy link", model.copyLink), row("revoke-open", "Revoke access", () => model.setConfirmRevoke(true), { destructive: true, enabled: !busy && !!props.onRevoke }),
      row("preview", "Preview referral page", () => openExternalUrl(summary.link), { chevron: true })]);
    group("activity", [row("opens", "Link opens", undefined, { trailing: summary.link_open_count?.toLocaleString() ?? "—" }),
      row("last", "Last opened", undefined, { detail: formatLocalDateTime(summary.last_opened_at ?? null) || "No opens yet" }),
      row("qualified", "Qualified referrals", undefined, { trailing: summary.qualified_count.toLocaleString() }),
      row("progress", "In progress", undefined, { trailing: summary.in_progress_count.toLocaleString() }),
      row("review", "Under review", undefined, { trailing: summary.under_review_count.toLocaleString() })], "Referral activity");
    if (summary.referrals.length) group("recent", summary.referrals.map((referral, index) => row(`recent-${index}`, referral.status, undefined, { detail: referral.step, trailing: referral.started_on })), "Recent referrals");
  }
  useLayoutEffect(() => publish({ title, busy, sections, actions, back: () => { if (model.confirmRevoke) model.setConfirmRevoke(false); else onClose(); }, ...(!model.confirmRevoke ? images : {}) }));
  return null;
}

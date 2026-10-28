"use client";

import { useCallback, useLayoutEffect } from "react";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { isInlineDecidableConsentEntry } from "@/lib/consent/owner-consent-request";
import { walletSharingKind } from "@/lib/services/wallet-sharing-service";
import { useWalletSharingOwner, expiryLabel } from "./wallet-sharing";
import { useWalletSharingHistoryOwner } from "./wallet-sharing-history";
import { useWalletSavedCardSharing } from "./wallet-saved-card-sharing";
import { nativeWalletSharingScene } from "./native-wallet-sharing-scene";
import type { WalletPanelProjection } from "./native-wallet-payment-panel";

/** Complete access navigation using the same consent, history and sharing
 * owners as web. Private authorization contexts never enter the projection. */
export function NativeWalletAccessPanel({ ownerId, getContext, handle, publish, onClose }: {
  ownerId: string; getContext: (id: string) => CardShareContext | null;
  handle: (key: string) => string; publish: (value: WalletPanelProjection) => void; onClose: () => void;
}) {
  const access = useWalletSharingOwner({ active: true, getHistoryContext: getContext });
  const history = useWalletSharingHistoryOwner({ ownerId, active: true, getContext }, true);
  const profileId = history.profile?.cardId;
  const getProfileContext = useCallback((id: string) => profileId && id === profileId ? getContext(id) : null, [profileId, getContext]);
  const sharing = useWalletSavedCardSharing({ card: { cardId: history.profile?.cardId ?? "" }, getContext: getProfileContext, disabled: !history.profile, native: true });
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const sections: NativeDrawerSection[] = [];
  const busy = access.busy || !!history.busy || sharing.busy;
  const row = (key: string, label: string, action?: () => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handle(key); if (action) actions.set(id, action);
    return { id, label, enabled: !busy, ...(!action ? { readOnly: true } : {}), ...extra };
  };
  const group = (key: string, rows: NativeDrawerRow[], title?: string) => sections.push({ id: handle(`section-${key}`), ...(title ? { title } : {}), rows });
  const back = () => {
    if (busy) return;
    if (sharing.revokeTarget) { sharing.setRevokeTarget(null); return; }
    if (sharing.open) { sharing.close(); return; }
    if (history.selection) { history.setSelection(null); return; }
    if (history.detail) { history.setOpened(null); return; }
    if (access.confirmRevoke) { access.setConfirmRevoke(false); return; }
    if (access.selection) { access.setSelection(null); return; }
    onClose();
  };
  let title = "Wallet access";
  if (access.selection) {
    const { entry, active } = access.selection;
    const details = walletSharingKind(entry) === "details";
    title = access.confirmRevoke ? "Stop sharing Wallet access?" : active ? "Manage access" : "Review request";
    if (access.confirmRevoke) group("access-confirm", [row("revoke-warning", "This revokes this recipient’s selected permission. Information they previously received cannot be taken back."), row("revoke", "Revoke access", () => access.mutate("revoke"), { destructive: true }), row("keep", "Keep sharing", () => access.setConfirmRevoke(false))]);
    else {
      group("access-details", [row("recipient", active ? "Shared with" : "Requested by", undefined, { detail: entry.counterpart_label || "Requester" }),
        row("included", "What is included", undefined, { detail: details ? "Card numbers and cardholder names. Saved security codes are not shared." : "Network, last four digits, expiry, nickname and issuing region." }),
        row("scope", "Which cards", undefined, { detail: "Wallet-wide access. This permission is not limited to one card." }),
        ...(entry.reason ? [row("reason", "Reason", undefined, { detail: entry.reason })] : []),
        ...(active ? [row("status", "Status", undefined, { detail: entry.status }), row("expires", "Access expires", undefined, { detail: expiryLabel(entry.expires_at) })] : [])]);
      if (!active) group("duration", [1, 24, 168].map(hours => row(`hours-${hours}`, hours === 1 ? "1 hour" : hours === 24 ? "24 hours" : "7 days", () => access.setDuration(hours), { selected: access.duration === hours })), "Access duration");
      if (details) group("warning", [row("sensitive", "Full card details are sensitive. Approve only if you trust this requester.")]);
      const canChange = !busy && !!access.vaultKey && !!access.current && !access.current.error;
      group("decision", active ? [row("revoke-open", "Revoke access", () => access.setConfirmRevoke(true), { destructive: true, enabled: canChange && !!entry.request_id && !!entry.scope })] :
        [row("decline", "Decline", () => access.mutate("decline"), { enabled: canChange && isInlineDecidableConsentEntry(entry) }), row("approve", "Approve", () => access.mutate("approve"), { enabled: canChange && isInlineDecidableConsentEntry(entry) })]);
      if (!access.vaultKey) group("locked", [row("locked", "Unlock your Wallet before changing access.")]);
      if (access.actionError) group("error", [row("error", access.actionError)]);
    }
  } else if (history.selection) {
    title = "Stop sharing this card?";
    group("history-confirm", [row("history-warning", "This stops future access. Information already received cannot be taken back."),
      row("history-revoke", "Revoke access", () => history.revoke(history.selection!), { destructive: true }), row("history-keep", "Keep sharing", () => history.setSelection(null))]);
  } else if (history.detail) {
    const item = history.detail;
    title = item.recipientName;
    const date = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    group("history-details", [row("card", "Shared card", undefined, { detail: item.displayLabel }), row("history-status", "Status", undefined, { detail: item.status }),
      row("shared", "Shared", undefined, { detail: date(item.createdAt) }), row("history-duration", "Access time", undefined, { detail: `${item.durationMinutes} minutes` }), row("history-expiry", "Expires", undefined, { detail: date(item.expiresAt) }),
      row("connection", "Connection", undefined, { detail: item.trustedCircle === true ? "Trusted Circle when shared" : item.trustedCircle === false ? "Connection" : "Earlier share" }),
      row("verification", "Verification", undefined, { detail: item.verifiedAt ? `Identity verified ${date(item.verifiedAt)}` : item.verificationMethod === "identity_reauthentication" ? "Identity verification required" : item.trustedCircle === true && item.verificationMethod === "trusted_circle" ? "Trusted access when shared" : "Verification details unavailable" }),
      ...(item.revokedAt ? [row("revoked", "Revoked", undefined, { detail: date(item.revokedAt) })] : []), ...(item.lastAccessedAt ? [row("viewed", "Last viewed", undefined, { detail: date(item.lastAccessedAt) })] : [])]);
    group("activity", item.activity.length ? item.activity.filter((event, index, events) => event.event !== "SHARE_OPENED" || index === events.findIndex(candidate => candidate.event === "SHARE_OPENED")).map((event, index) => row(`event-${index}`, event.event.toLowerCase().replaceAll("_", " "), undefined, { detail: date(event.at) })) : [row("no-activity", "No activity yet")], "Activity");
    if (item.status === "active") group("history-actions", [row("history-revoke-open", "Revoke access", () => history.setSelection(item), { destructive: true })]);
  } else {
    group("grants", !access.current ? [row("loading", "Loading shared access…")] : access.current.error ? [row("retry", "Try again", () => access.setRevision(value => value + 1), { detail: "Could not load shared access." })] : access.current.grants.length ? access.current.grants.map(entry => row(`grant-${entry.request_id || entry.id}`, entry.counterpart_label || "Requester", () => access.open(entry, true), { detail: walletSharingKind(entry) === "details" ? "Card details" : "Card summary", chevron: true })) : [row("empty", "Not shared with anyone yet.")], "Wallet-wide access");
    if (history.profile?.context.isCurrent()) group("share-profile", [row("share-profile", "Share Wallet Profile", () => sharing.setOpen(true), { artworkId: "invite", chevron: true })]);
    group("history", history.failed ? [row("history-retry", "Try again", history.retry, { detail: history.unavailable ? "Card sharing is unavailable. Automatic refresh is paused." : "Could not refresh card sharing." })] : !history.current ? [row("history-loading", "Loading shared cards…")] : history.current.page.items.length ? history.current.page.items.map(item => row(`history-${item.id}`, item.recipientName, () => history.setOpened({ id: item.id, cardType: item.cardType }), { detail: item.displayLabel, trailing: item.status, chevron: true })) : [row("history-empty", "No cards shared yet")], "Shared cards");
    if (history.current?.page.nextCursor) group("more", [row("more", history.loading ? "Loading more shares…" : history.moreFailed ? "Retry loading shares" : "Load more shares", history.loadMore, { enabled: !history.loading })]);
  }
  const shareScene = sharing.open || sharing.revokeTarget ? nativeWalletSharingScene({ sharing, page: "share", disabled: busy && !sharing.busy, handle: key => handle(`profile-${key}`), back }) : null;
  useLayoutEffect(() => publish(shareScene ?? { title, busy, sections, actions, back }));
  return null;
}

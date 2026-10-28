"use client";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import type { useWalletSavedCardSharing } from "./wallet-saved-card-sharing";
import type { WalletPanelProjection } from "./native-wallet-payment-panel";

/** One native recipient/access presentation for payment and Profile cards.
 * The existing sharing owner retains all authorisation and operation state. */
export function nativeWalletSharingScene({ sharing, page, disabled, handle, back }: {
  sharing: ReturnType<typeof useWalletSavedCardSharing>; page: string; disabled: boolean;
  handle: (key: string) => string; back: () => void;
}): WalletPanelProjection | null {
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const sections: NativeDrawerSection[] = [];
  const row = (key: string, label: string, action?: (choice: NativeWorkspaceChoice) => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handle(key); if (action) actions.set(id, action);
    return { id, label, enabled: !disabled && !sharing.busy, ...(!action ? { readOnly: true } : {}), ...extra };
  };
  const group = (key: string, rows: NativeDrawerRow[], title?: string) => sections.push({ id: handle(`section-${key}`), ...(title ? { title } : {}), rows });
  let title = "";
  if (sharing.revokeTarget) {
    title = "Revoke access?";
    group("revoke", [row("revoke-note", "This stops future access. Details already viewed cannot be recalled."),
      row("revoke", "Revoke access", () => sharing.revoke(sharing.revokeTarget!), { destructive: true }),
      row("keep", "Keep sharing", () => sharing.setRevokeTarget(null))]);
  } else if (page === "share") {
    title = sharing.isProfile ? "Share Profile Card" : "Share card";
    if (sharing.stateFailed) group("share-error", [row("share-retry", "Retry sharing", () => sharing.setRevision(value => value + 1), { detail: sharing.unavailable ? "Card sharing is temporarily unavailable." : "Could not check sharing." })]);
    group("recipients", sharing.loading ? [row("recipients-loading", "Finding connections…")] : sharing.failed ? [row("recipients-retry", "Retry connections", () => sharing.setRecipientRevision(value => value + 1))] :
      sharing.recipients.length ? sharing.recipients.map(recipient => row(`recipient-${recipient.personRef}`, recipient.displayName, () => sharing.setSelected(previous => {
        const next = { ...previous }; if (next[recipient.personRef]) delete next[recipient.personRef]; else if (Object.keys(next).length < 20) next[recipient.personRef] = recipient; return next;
      }), { selected: !!sharing.selected[recipient.personRef], enabled: !disabled && !sharing.busy && (sharing.selectedCount < 20 || !!sharing.selected[recipient.personRef]), ...(recipient.trusted ? { detail: "Trusted Circle" } : {}) })) : [row("recipients-empty", "No connections found.")], "Connections");
    group("duration", ([15, 60, 120] as const).map(minutes => row(`duration-${minutes}`, minutes === 15 ? "15 minutes" : minutes === 60 ? "1 hour" : "2 hours", () => sharing.setDuration(minutes), { selected: sharing.duration === minutes })), "Access time");
    group("send", [row("share-send", sharing.busy ? "Sharing…" : `Share with ${sharing.selectedCount}`, sharing.send, { enabled: !disabled && !sharing.busy && !sharing.stateFailed && !!sharing.state && sharing.selectedCount > 0 }),
      row("share-note", sharing.isProfile ? "Only your selected profile details are shared." : "Shares the full card number, name, network and expiry. CVV and PIN are never shared."),
      row("verification-note", "People outside your Trusted Circle verify their identity before viewing."),
      ...(sharing.hasMore ? [row("more-connections", "Search by name to find more connections.")] : [])]);
  } else if (page === "access") {
    title = "Manage access";
    group("grants", sharing.stateFailed ? [row("state-retry", "Retry sharing", () => sharing.setRevision(value => value + 1))] : !sharing.state ? [row("state-loading", "Loading shares…")] :
      sharing.state.grants.length ? sharing.state.grants.map(grant => row(`grant-${grant.id}`, grant.recipientName, grant.status === "active" ? () => sharing.setRevokeTarget(grant.id) : undefined,
        { detail: grant.status === "active" ? `Access ends ${new Date(grant.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : grant.status === "revoked" ? "Revoked" : "Expired", ...(grant.status === "active" ? { trailing: "Revoke", destructive: true } : {}) })) : [row("grants-empty", "No active shares")], "Shared with");
    if (sharing.state?.nextCursor) group("more", [row("more", sharing.loadingMore ? "Loading more shares…" : "Load more shares", sharing.loadMore, { enabled: !sharing.loadingMore })]);
    if (sharing.currentCopies.length) group("copies", [...sharing.currentCopies].reverse().map(receipt => row(`copy-${receipt.messageId}`, receipt.recipientName, undefined, { detail: "Sent copy · cannot be recalled", trailing: new Date(receipt.sentAt).toLocaleDateString() })), "Previously sent copies");
  } else { return null; }
  let search: WalletPanelProjection["search"];
  if (page === "share" && !sharing.revokeTarget) {
    search = { id: handle("search"), query: sharing.query, label: "Search connections" };
    actions.set(search.id, choice => { if (choice.text !== undefined) sharing.setQuery(choice.text); });
  }
  return { title, busy: disabled || sharing.busy, sections, search, actions, back };
}

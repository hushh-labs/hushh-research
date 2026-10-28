"use client";

import { useLayoutEffect, useState } from "react";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { PrivateProfileEditorModel } from "@/lib/capacitor/native-profile-private-editor";
import type { NativeWalletProfileDraft } from "@/lib/capacitor/native-wallet-profile-editor";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import type { WalletCardSummary } from "@/lib/services/wallet-service";
import type { CardShareContext } from "@/lib/services/wallet-card-share-service";
import { maskedCardNumberGroups } from "@/lib/wallet/wallet-card-presentation";
import { useWalletSecurityCode } from "./wallet-security-code";
import { nativeWalletSharingScene } from "./native-wallet-sharing-scene";
import { useWalletSavedCardSharing } from "./wallet-saved-card-sharing";
import { cardNetworkLabel } from "./card-network-mark";

export type WalletPanelProjection = {
  title: string; busy: boolean; qrData?: string; imageData?: string;
  editor?: PrivateProfileEditorModel<NativeWalletProfileDraft> & { destinationId: string; onSaved: () => void; onCancel: () => void }; sections: NativeDrawerSection[];
  search?: { id: string; query: string; label: string };
  actions: ReadonlyMap<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>;
  back: () => void;
};
export type NativeWalletPaymentOperations = {
  copyNumber: (cardId: string) => Promise<boolean>;
  readSecurityCode: (cardId: string) => Promise<string | undefined>;
  removeConfirmed: (card: WalletCardSummary) => void;
  getShareContext: (cardId: string) => CardShareContext | null;
};

/** Same readers, share/revoke state machine and delete operation as the web
 * panel. This adapter only authors the complete native presentation. */
export function NativeWalletPaymentPanel({ card, name, operations, disabled, handle, publish, onClose }: {
  card: WalletCardSummary; name?: string; operations: NativeWalletPaymentOperations; disabled: boolean;
  handle: (key: string) => string; publish: (value: WalletPanelProjection) => void; onClose: () => void;
}) {
  const [page, setPage] = useState<"details" | "share" | "access" | "remove">("details");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const code = useWalletSecurityCode({ active: !disabled && page === "details", onRead: () => operations.readSecurityCode(card.cardId) });
  const sharing = useWalletSavedCardSharing({ card, getContext: operations.getShareContext, disabled, compact: true, native: true });
  useLayoutEffect(() => { if (page === "share" && !sharing.open && !sharing.busy) setPage("details"); }, [page, sharing.open, sharing.busy]);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const sections: NativeDrawerSection[] = [];
  const row = (key: string, label: string, action?: (choice: NativeWorkspaceChoice) => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handle(key); if (action) actions.set(id, action);
    return { id, label, enabled: !disabled && !sharing.busy && !copying, ...(!action ? { readOnly: true } : {}), ...extra };
  };
  const group = (key: string, rows: NativeDrawerRow[], title?: string) => sections.push({ id: handle(`section-${key}`), ...(title ? { title } : {}), rows });
  const back = () => {
    if (sharing.busy || copying) return;
    if (sharing.revokeTarget) { sharing.setRevokeTarget(null); return; }
    if (page === "details") { code.hide(); onClose(); return; }
    sharing.close(); code.hide(); setPage("details"); setFeedback(null);
  };
  const copy = async (value: string | undefined, number = false) => {
    if (copying || disabled) return;
    setCopying(true); setFeedback(null);
    try {
      if (number) { if (!await operations.copyNumber(card.cardId)) return; }
      else { if (!value || !navigator.clipboard?.writeText) throw new Error("CLIPBOARD_UNAVAILABLE"); await navigator.clipboard.writeText(value); }
      setFeedback("Copied.");
    } catch { setFeedback("Could not copy. Try again."); }
    finally { setCopying(false); }
  };
  let title = card.nickname || cardNetworkLabel(card.brand);
  if (page === "remove") {
    title = `Remove ${card.nickname || `${cardNetworkLabel(card.brand)} ending ${card.last4}`}?`;
    group("remove", [row("remove-note", "This removes the card and its details from your vault on every device. You can add it again later."),
      row("remove-confirm", "Remove card", () => operations.removeConfirmed(card), { destructive: true }),
      row("remove-cancel", "Keep card", () => setPage("details"))]);
  } else {
    const expiry = `${String(card.expiryMonth).padStart(2, "0")}/${String(card.expiryYear).slice(-2)}`;
    group("sharing", [row("share-open", "Share card", () => { sharing.setOpen(true); setPage("share"); }, { artworkId: "invite", chevron: true }), row("access-open", "Manage access", () => setPage("access"), { artworkId: "security", chevron: true })]);
    group("details", [row("number", "Card number", () => copy(undefined, true), { detail: maskedCardNumberGroups(card.brand, card.last4).join(" "), artworkId: "account-wallet", trailing: "Copy" }),
      row("holder", "Name on card", name ? () => copy(name) : undefined, { detail: name || "Not provided", artworkId: "account-name" }),
      row("network", "Card network", () => copy(cardNetworkLabel(card.brand)), { detail: cardNetworkLabel(card.brand) }),
      row("expiry", "Expiry (MM/YY)", () => copy(expiry), { detail: expiry }),
      row("region", "Issuing region", card.issuingRegion ? () => copy(card.issuingRegion) : undefined, { detail: card.issuingRegion || "Not provided" }),
      row("cvv", code.visible ? "Hide CVV" : "Show CVV", code.toggle, { detail: code.view.kind === "visible" ? code.view.value : code.view.kind === "missing" ? "Not saved" : code.view.kind === "error" ? "Could not show CVV. Try again." : "•••", enabled: !disabled && code.view.kind !== "reading" }),
      row("remove-open", "Remove card", () => { code.hide(); setPage("remove"); }, { destructive: true, chevron: true, artworkId: "account-delete" })], "Card details");
  }
  if (feedback) group("feedback", [row("feedback", feedback)]);
  const sharingScene = nativeWalletSharingScene({ sharing, page, disabled: disabled || copying, handle, back });
  // The parent stores only the private projection. Callback refreshes do not
  // manufacture a new presentation revision or trigger another operation.
  useLayoutEffect(() => publish(sharingScene ?? { title, busy: disabled || copying, sections, actions, back }));
  return null;
}

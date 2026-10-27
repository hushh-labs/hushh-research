"use client";

import { walletPublicCardActions } from "@/components/wallet-card/public-card-view";
import { assignWindowLocation, openExternalUrl } from "@/lib/utils/browser-navigation";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { WalletProfileOwner } from "@/components/wallet-card/wallet-card-workspace";
import { WALLET_CARD_CONFIRMATIONS, WALLET_CARD_COPY, WALLET_CARD_OWNER_COPY } from "@/components/wallet-card/wallet-card-copy";
import { validNativeWalletProfileDraft, type NativeWalletProfileDraft } from "@/lib/capacitor/native-wallet-profile-editor";
import type { NativeDrawerRow, NativeDrawerSection } from "@/lib/capacitor/native-drawers";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { formatLocalDateTime } from "@/lib/utils/local-date-time";
import { useWalletCardImageShare } from "./wallet-card-image-share-button";
import { useNativeWalletImages } from "./use-native-wallet-images";
import type { WalletPanelProjection } from "./native-wallet-payment-panel";

/** Native presentation of the existing Wallet Profile owner, including its
 * editor and confirmations. Services, payload validation and pass handoff stay
 * in that owner; native receives neither owner authority nor a share token. */
export function NativeWalletIdentityPanel({ model, variant, handle, publish, onClose }: {
  model: WalletProfileOwner; variant: "profile" | "nws"; handle: (key: string) => string;
  publish: (value: WalletPanelProjection) => void; onClose: () => void;
}) {
  const live = useRef(model);
  useLayoutEffect(() => { live.current = model; });
  const editing = model.stage === "edit";
  const entry = useMemo(() => {
    if (!editing) return null;
    let revision = 0, pending = false, draft: NativeWalletProfileDraft | undefined;
    return {
      destinationId: crypto.randomUUID(), inputRevision: () => revision, mutationPending: () => pending,
      accept: (next: NativeWalletProfileDraft, expected?: number) => {
        if (pending || expected !== undefined && expected !== revision) return false;
        draft = { ...next }; revision++; return true;
      },
      save: async (fallback: NativeWalletProfileDraft, commit: (next: NativeWalletProfileDraft) => Promise<boolean>) => {
        if (pending) return false;
        pending = true;
        try { return await commit(draft ?? fallback); } finally { pending = false; }
      },
    };
  }, [editing]);
  const sharing = useWalletCardImageShare({ cardId: variant === "nws" ? "agent-one-nws" : "agent-one-profile", profile: model.imageShareProfile,
    disabled: model.card?.status !== "active" || !model.shareLink || model.saving || model.busyAction !== null });
  const images = useNativeWalletImages(model.card?.status === "active" ? model.shareLink?.shareUrl : null, sharing.ready);
  const actions = new Map<string, (choice: NativeWorkspaceChoice) => void | Promise<unknown>>();
  const sections: NativeDrawerSection[] = [];
  const busy = model.saving || model.busyAction !== null || sharing.sharing;
  const row = (key: string, label: string, action?: () => void | Promise<unknown>, extra: Partial<NativeDrawerRow> = {}): NativeDrawerRow => {
    const id = handle(key); if (action) actions.set(id, action);
    return { id, label, enabled: !busy, ...(!action ? { readOnly: true } : {}), ...extra };
  };
  const group = (key: string, rows: NativeDrawerRow[], title?: string) => sections.push({ id: handle(`section-${key}`), ...(title ? { title } : {}), rows });
  const back = () => {
    if (busy) return;
    if (model.confirm) { model.setConfirm(null); return; }
    if (!model.closeLocalStage()) onClose();
  };
  let title = model.header.title;
  if (model.confirm) {
    const confirmation = WALLET_CARD_CONFIRMATIONS[model.confirm]; title = confirmation.title;
    group("confirmation", [row("confirmation-note", confirmation.body), row("confirm", confirmation.confirmLabel, model.runConfirmedAction, { destructive: model.confirm === "remove" || model.confirm === "rotate" }), row("cancel-confirm", "Cancel", () => model.setConfirm(null))]);
  } else if (model.stage === "loading") group("loading", [row("loading", "Loading your Wallet Profile…")]);
  else if (model.stage === "locked") group("locked", [row("locked", WALLET_CARD_OWNER_COPY.vaultLocked)]);
  else if (model.stage === "unavailable") group("unavailable", [row("unavailable", WALLET_CARD_OWNER_COPY.featureUnavailable)]);
  else if (model.stage === "error") group("error", [row("error", WALLET_CARD_OWNER_COPY.loadFailed), row("retry", "Try again", model.loadCard)]);
  else if (model.stage === "intro") group("intro", [row("intro", WALLET_CARD_COPY.setupIntro.title, undefined, { detail: WALLET_CARD_COPY.setupIntro.description }),
    row("privacy", WALLET_CARD_COPY.privacyAssurance.title, undefined, { detail: WALLET_CARD_COPY.privacyAssurance.description }), row("setup", "Set up Wallet Profile", model.startSetup, { artworkId: "account-wallet", chevron: true })]);
  else if (model.stage === "success") group("success", [row("success", WALLET_CARD_COPY.success.title, undefined, { detail: WALLET_CARD_COPY.success.description }), row("done", WALLET_CARD_COPY.entryAfterSetup.title, () => { model.closeLocalStage(); })]);
  else if (model.stage === "preview") {
    const preview = model.visitorPreview;
    if (preview.status === "error") group("preview-error", [row("preview-error", preview.message), row("preview-retry", "Try again", model.loadVisitorPreview)]);
    else if (preview.status !== "ready") group("preview-loading", [row("preview-loading", "Loading preview…")]);
    else {
      const card = preview.card;
      group("preview", [
        ["fullName", "Name"], ["headline", "Headline"], ["organisation", "Organisation"], ["locationLabel", "Location"], ["summary", "About"],

      ].flatMap(([key, label]) => { const value = card[key as keyof typeof card]; return typeof value === "string" && value ? [row(`preview-${key}`, label!, undefined, { detail: value })] : []; }));
      const contacts = walletPublicCardActions(card);
      if (contacts.length) group("contacts", contacts.map(contact => row(`contact-${contact.id}`, contact.label,
        () => contact.external ? openExternalUrl(contact.href) : assignWindowLocation(contact.href), { artworkId: contact.id === "email" ? "account-mail" : contact.id === "phone" ? "account-phone" : "world-model", chevron: true })), "Contact");
      if (card.skills.length) group("skills", [row("skills", "Skills", undefined, { detail: card.skills.join(", ") })]);
    }
    group("preview-actions", [...(model.previewOrigin === "setup" ? [model.applePassSupported ? row("setup-apple-wallet", WALLET_CARD_OWNER_COPY.addToWallet, model.addToWallet, { enabled: !busy && !!model.shareLink, artworkId: "account-wallet" }) : row("setup-share", "Share card", sharing.share, { enabled: !busy && !!(sharing.ready || sharing.failed), artworkId: "invite" })] : []), row("preview-edit", WALLET_CARD_OWNER_COPY.editInformation, model.startEdit), row("preview-done", "Done", () => { model.closeLocalStage(); })]);
  } else if (model.stage === "manage" && model.card) {
    const card = model.card;
    group("status", [row("status", card.status === "paused" ? WALLET_CARD_OWNER_COPY.statusPaused : WALLET_CARD_OWNER_COPY.statusActive),
      row("updated", WALLET_CARD_OWNER_COPY.lastUpdatedLabel, undefined, { detail: formatLocalDateTime(card.updatedAt) || "—" }),
      row("scans", WALLET_CARD_OWNER_COPY.scanCountLabel, undefined, { trailing: card.scanCount.toLocaleString() }),
      row("last-scan", WALLET_CARD_OWNER_COPY.lastScannedLabel, undefined, { detail: formatLocalDateTime(card.lastScannedAt) || "No scans yet" })]);
    group("actions", [row("apple-wallet", WALLET_CARD_OWNER_COPY.addToWallet, model.addToWallet, { enabled: !busy && !!model.shareLink, artworkId: "account-wallet" }),
      row("share", sharing.failed ? "Retry card image" : "Share card", sharing.share, { enabled: !busy && !!(sharing.ready || sharing.failed), artworkId: "invite" }),
      row("copy", WALLET_CARD_OWNER_COPY.copyLink, () => model.onManageAction("copy"), { enabled: !busy && !!model.shareLink }),
      row("preview", WALLET_CARD_OWNER_COPY.previewAsVisitor, () => model.onManageAction("preview"), { chevron: true }),
      row("edit", WALLET_CARD_OWNER_COPY.editInformation, model.startEdit, { chevron: true }),
      row("pause", card.status === "paused" ? WALLET_CARD_OWNER_COPY.resumeSharing : WALLET_CARD_OWNER_COPY.pauseSharing, () => model.onManageAction(card.status === "paused" ? "resume" : "pause")),
      row("rotate", WALLET_CARD_OWNER_COPY.revokeAccess, () => model.onManageAction("rotate"), { destructive: true }),
      row("remove", WALLET_CARD_OWNER_COPY.removeProfile, () => model.onManageAction("remove"), { destructive: true, artworkId: "account-delete" })]);
  }
  let editor: WalletPanelProjection["editor"];
  if (entry && editing) {
    editor = {
      destinationId: entry.destinationId, draft: model.draft, busy: model.saving, error: Object.values(model.errors).filter(Boolean).join("\n").slice(0, 1024) || null, canSave: !model.saving,
      current: () => live.current.stage === "edit" && live.current.userId === model.userId,
      inputRevision: entry.inputRevision, mutationPending: entry.mutationPending,
      changeDraft: (draft: NativeWalletProfileDraft, expected) => {
        if (!validNativeWalletProfileDraft(draft) || live.current.stage !== "edit" || !entry.accept(draft, expected)) return false;
        live.current.replaceDraft(draft); return true;
      },
      save: async () => {
        if (live.current.stage !== "edit") return false;
        return entry.save(live.current.draft, live.current.submitDraft);
      },
      onSaved: () => {}, onCancel: () => { live.current.closeLocalStage(); },
    };
  }
  useLayoutEffect(() => publish({ title, busy, sections, actions, back, editor, ...(!editing && !model.confirm ? images : {}) }));
  return null;
}

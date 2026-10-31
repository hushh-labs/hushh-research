import { describe, expect, it, vi } from "vitest";
import { NativeWalletCardFence, type NativeWalletCardProjection } from "@/lib/capacitor/native-wallet-card";
import { boundNativeWalletArtwork, validNativeWalletCollection } from "@/lib/capacitor/native-wallet-workspace";
import { workspaceChoiceDomainAllowed, type NativeWorkspaceProjection, type NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { validNativeWalletProfileDraft } from "@/lib/capacitor/native-wallet-profile-editor";
import { EMPTY_WALLET_CARD_DRAFT } from "@/components/wallet-card/wallet-card-fields";
import { nativeChromeSizeAllowed } from "@/lib/capacitor/native-chrome-controls";
import { retainNativeFeedbackSink, withNativeFeedbackScope, nativeSinkFeedbackOptions, reconcileNativeSinkFeedback, isNativeSinkFeedback } from "@/lib/capacitor/native-feedback-sink";
import type { ToastT } from "sonner";

it("retires private feedback on a destination change without replaying it", () => {
  let key = "public-owner:visit-a", ready = false;
  const show = vi.fn(), hide = vi.fn();
  const release = retainNativeFeedbackSink({ capture: () => key, ready: () => ready, show, hide });
  try {
    const options = nativeSinkFeedbackOptions()!;
    const toasts = [{ ...options, title: "Public fixture", type: "success", duration: 1000 }] as ToastT[];
    reconcileNativeSinkFeedback(toasts);
    expect(show).not.toHaveBeenCalled();
    ready = true;
    reconcileNativeSinkFeedback(toasts);
    expect(show).toHaveBeenCalledTimes(1);
    key = "public-owner:visit-b";
    reconcileNativeSinkFeedback(toasts);
    expect(hide).toHaveBeenCalledWith("public-owner:visit-a", options.id);
    expect(isNativeSinkFeedback(options.id)).toBe(false);
    reconcileNativeSinkFeedback(toasts);
    expect(show).toHaveBeenCalledTimes(1);
  } finally { release(); }
});

it("admits only the current detail while its sheet isolates base actions", () => {
  const wallet = { cards: [{ id: "public-card", kind: "payment" as const, title: "Public fixture", subtitle: "Visa", network: "Visa", last4: "4242", holder: "Fixture", expiry: "12/30" }],
    selectedId: "public-card", detailVisitId: "visit-b", closeId: "close", addId: "add", addEnabled: true, detailTitle: "Fixture", detailBusy: false };
  const state = { workspace: "wallet", wallet, sections: [{ id: "details", rows: [{ id: "copy", label: "Copy", enabled: true }] }] } as NativeWorkspaceProjection;
  const choice = { action: "row", rowId: "copy", domain: "wallet-detail", detailVisitId: "visit-b" } as NativeWorkspaceChoice;
  expect(workspaceChoiceDomainAllowed(choice, state, true)).toBe(true);
  expect(workspaceChoiceDomainAllowed({ ...choice, detailVisitId: "visit-a" }, state, true)).toBe(false);
  expect(workspaceChoiceDomainAllowed({ ...choice, domain: undefined, rowId: "add" }, state, true)).toBe(false);
  expect(workspaceChoiceDomainAllowed({ ...choice, dismissed: true }, state, true)).toBe(false);
  expect(workspaceChoiceDomainAllowed({ ...choice, dismissed: true, rowId: "close" }, state, true)).toBe(true);
  expect(validNativeWalletCollection(wallet)).toBe(true);
  expect(validNativeWalletCollection({ ...wallet, ownerToken: "forbidden" } as typeof wallet)).toBe(false);
  expect(validNativeWalletProfileDraft(EMPTY_WALLET_CARD_DRAFT)).toBe(true);
  expect(validNativeWalletProfileDraft({ ...EMPTY_WALLET_CARD_DRAFT, vaultKey: "forbidden" })).toBe(false);
});

it("preserves bounded authored map geometry without relaxing ordinary chrome", () => {
  expect(nativeChromeSizeAllowed("map-close", 56, 56)).toBe(true);
  expect(nativeChromeSizeAllowed("map-check-in", 112, 44)).toBe(true);
  expect(nativeChromeSizeAllowed("map-close", 112, 56)).toBe(false);
  expect(nativeChromeSizeAllowed("history", 56, 56)).toBe(false);
});
describe("private route-owned card editor", () => {
  it("rejects obsolete draft bases and consumes a confirmed save only once", async () => {
    const state: NativeWalletCardProjection = {
      documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, visitId: "public-card-visit",
      updateSequence: 1, privacyGeneration: 0, acknowledgedEditRevision: 0, draftRevision: 2,
      draft: { pan: "", cardholderName: "", expiry: "", network: "auto", issuingRegion: "none", securityCode: "" },
      busy: false, canSave: true, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111",
      networks: [{ id: "auto", label: "Auto-detect", selected: true }], regions: [{ id: "none", label: "Select region", selected: true }],
      collectSecurityCode: true, scanEnabled: true, networkLoading: false,
    };
    const fence = new NativeWalletCardFence(state);
    expect(fence.update(state)).toBe(true);
    const edit = { documentId: state.documentId, ownerEpoch: state.ownerEpoch, ownerGeneration: 1, revision: 1, visitId: state.visitId,
      updateSequence: 1, privacyGeneration: 0, editRevision: 1, baseDraftRevision: 1, composing: false, draft: { ...state.draft } };
    expect(fence.consumeEdit(edit)).toBe(false);
    expect(fence.consumeEdit({ ...edit, baseDraftRevision: 2 })).toBe(true);
    expect(fence.update({ ...state, updateSequence: 2, acknowledgedEditRevision: 1 })).toBe(true);
    const { draft: _draft, composing: _composing, baseDraftRevision: _base, ...identity } = edit;
    const action = { ...identity, updateSequence: 2, action: "save" as const, sequence: 1 };
    const confirm = vi.fn().mockResolvedValue({ valid: true });
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(true);
    expect(await fence.consumeAction(action, confirm, () => true)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    fence.retire();
    expect(fence.consumeEdit({ ...edit, baseDraftRevision: 2, editRevision: 2 })).toBe(false);
  });
});


it("keeps late artwork within the whole bridge budget without losing card actions", () => {
  const image = "data:image/png;base64," + "/".repeat(350_000);
  const cards = Array.from({ length: 5 }, (_, index) => ({ id: `fixture-${index}`, kind: "payment" as const, title: "Public fixture", subtitle: "Visa", network: "Visa", last4: "4242", holder: "", expiry: "12/30", imageData: image }));
  const wallet = { cards, selectedId: cards[4]!.id, detailVisitId: "visit", closeId: "close", addId: "add", addEnabled: true, detailTitle: "Fixture", detailBusy: false, detailQrData: image };
  const before = JSON.stringify(wallet);
  const projected = boundNativeWalletArtwork({ wallet });
  expect(new TextEncoder().encode(JSON.stringify(projected).replaceAll("/", "\\/")).byteLength).toBeLessThan(900_000);
  expect(projected.wallet.detailQrData).toBe(image);
  expect(projected.wallet.cards.map(card => card.id)).toEqual(cards.map(card => card.id));
  expect(projected.wallet.closeId).toBe("close");
  expect(validNativeWalletCollection(projected.wallet)).toBe(true);
  expect(JSON.stringify(wallet)).toBe(before);
});

it("keeps an explicitly route-owned operation outcome until its child closes", () => {
  let route = "owner-a:wallet-visit", child = "card-a", childOpen = true;
  const show = vi.fn(), hide = vi.fn();
  const release = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? route : `${route}:${child}`, ready: () => !childOpen, show, hide });
  try {
    const options = withNativeFeedbackScope("workspace", () => nativeSinkFeedbackOptions()!);
    const toasts = [{ ...options, title: "Card removed.", type: "success", duration: 1000 }] as ToastT[];
    reconcileNativeSinkFeedback(toasts);
    child = "card-b";
    reconcileNativeSinkFeedback(toasts);
    expect(show).not.toHaveBeenCalled();
    expect(isNativeSinkFeedback(options.id)).toBe(true);
    childOpen = false;
    reconcileNativeSinkFeedback(toasts);
    expect(show).toHaveBeenCalledTimes(1);
    route = "owner-b:wallet-visit";
    reconcileNativeSinkFeedback(toasts);
    expect(isNativeSinkFeedback(options.id)).toBe(false);
    expect(hide).toHaveBeenCalledWith("owner-a:wallet-visit", options.id);
  } finally { release(); }
});

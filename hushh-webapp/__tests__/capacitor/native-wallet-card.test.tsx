import { describe, expect, it, vi } from "vitest";
import { NativeWalletCardFence, type NativeWalletCardProjection } from "@/lib/capacitor/native-wallet-card";
import { boundNativeWalletArtwork, validNativeWalletCollection } from "@/lib/capacitor/native-wallet-workspace";
import { nativeWorkspaceFrameFromAnchors, validNativeWorkspace, workspaceChoiceDomainAllowed, type NativeWorkspaceProjection, type NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { validNativeWalletProfileDraft } from "@/lib/capacitor/native-wallet-profile-editor";
import { EMPTY_WALLET_CARD_DRAFT } from "@/components/wallet-card/wallet-card-fields";
import { nativeChromeSizeAllowed } from "@/lib/capacitor/native-chrome-controls";
import { retainNativeFeedbackSink, withNativeFeedbackScope, nativeSinkFeedbackOptions, reconcileNativeSinkFeedback, isNativeSinkFeedback } from "@/lib/capacitor/native-feedback-sink";
import { retainNativeFeedbackConsumer } from "@/lib/capacitor/native-feedback";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { toast } from "sonner";
import type { ToastT } from "sonner";

it("composes the Wallet frame from the fixed seat and authored AppPageShell bounds", () => {
  const anchors = {
    seat: { x: 16, y: 112, width: 358, height: 620 }, shell: { x: 16, width: 358 },
    viewport: { width: 390, height: 844 }, shellInsets: { left: 16, right: 16 }, layoutRevision: 1,
  };
  expect(nativeWorkspaceFrameFromAnchors(anchors)).toEqual({
    x: 16, y: 112, width: 358, height: 620, viewportWidth: 390, viewportHeight: 844, layoutRevision: 1, contentInset: 16,
  });
  expect(nativeWorkspaceFrameFromAnchors({ ...anchors, shell: { x: 20, width: 390 } })).toBeNull();
  expect(nativeWorkspaceFrameFromAnchors({ ...anchors, shellInsets: { left: 16, right: 24 } })).toBeNull();
  // Paint continues behind floating chrome, but the final row remains clear.
  const paint = { ...anchors, seat: { ...anchors.seat, height: 732 }, bottomContentInset: 112 };
  expect(nativeWorkspaceFrameFromAnchors(paint)).toMatchObject({ height: 732, bottomContentInset: 112 });
  // The acknowledged keyboard replaces the chrome clearance rather than
  // reserving both regions in a shortened keyboard viewport.
  expect(nativeWorkspaceFrameFromAnchors({ ...anchors, seat: { ...anchors.seat, height: 400 }, bottomContentInset: 0 }))
    .toMatchObject({ height: 400 });
  expect(nativeWorkspaceFrameFromAnchors({ ...paint, bottomContentInset: 732 })).toBeNull();
  expect(nativeWorkspaceFrameFromAnchors({ ...paint, bottomContentInset: -1 })).toBeNull();
});

it("requires the native shared tab, selected state, and authored CSS canvas to agree", () => {
  const state: NativeWorkspaceProjection = {
    documentId: "public-document", ownerEpoch: "public-owner", ownerGeneration: 1, revision: 1, workspace: "wallet",
    appearance: "dark", accentHex: "#007aff", foregroundHex: "#f5f5f7", canvasHex: "#0e0e10",
    updateSequence: 1, privacyGeneration: 0, isolationGeneration: 0,
    frame: { x: 16, y: 112, width: 358, height: 620, viewportWidth: 390, viewportHeight: 844, layoutRevision: 1, contentInset: 0 },
    page: "overview", title: "Shared with me", enabled: true, backEnabled: false,
    sections: [{ id: "history", rows: [{ id: "loading", label: "Loading shared cards…", enabled: false, readOnly: true }] }],
    tabs: { label: "Wallet", options: [{ id: "my-cards", label: "My cards", selected: false }, { id: "shared", label: "Shared with me", selected: true }] },
    wallet: { cards: [], addId: "add", addEnabled: true, selectedId: null, detailVisitId: null, closeId: "close", detailTitle: "Shared with me", detailBusy: false, sharedTabId: "shared", view: "sharing" },
  };
  expect(validNativeWorkspace(state)).toBe(true);
  expect(validNativeWorkspace({ ...state, canvasHex: undefined })).toBe(false);
  expect(validNativeWorkspace({ ...state, tabs: { ...state.tabs!, options: state.tabs!.options.map(option => ({ ...option, selected: option.id === "my-cards" })) } })).toBe(false);
});

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
  const navigation = { sectionId: "navigation", allId: "all", previousId: "previous", nextId: "next", addId: "detail-add", position: 1, total: 1 };
  expect(validNativeWalletCollection({ ...wallet, navigation })).toBe(true);
  expect(validNativeWalletCollection({ ...wallet, navigation: { ...navigation, position: 2 } })).toBe(false);
  expect(validNativeWalletCollection({ ...wallet, navigation: { ...navigation, nextId: navigation.addId } })).toBe(false);
  const profile = { ...wallet, cards: [{ ...wallet.cards[0], kind: "profile" as const }] };
  const visitor = { name: "Public fixture", headline: "Designer", organisation: "Example", location: "Example", summary: "About", skills: ["Craft"] };
  expect(validNativeWalletCollection({ ...profile, visitor })).toBe(true);
  expect(validNativeWalletCollection({ ...profile, visitor: { ...visitor, avatarUrl: "https://example.org/private" } } as never)).toBe(false);
  expect(validNativeWalletCollection({ ...profile, visitor, navigation })).toBe(false);
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
      busy: false, canSave: true, draftValid: false, appearance: "light", accentHex: "#007aff", foregroundHex: "#111111",
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

it("waits to publish Card saved feedback until its child closes and retires stale routes without replay", () => {
  let route = "owner-a:wallet-visit", child = "card-a", childOpen = true;
  const show = vi.fn(), hide = vi.fn();
  const releaseConsumer = retainNativeFeedbackConsumer();
  const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? route : `${route}:${child}`, ready: () => !childOpen, show, hide });
  let toastId: string | undefined;
  try {
    toastId = String(withNativeFeedbackScope("workspace", () => morphyToast.success("Card saved.")));
    const toasts = () => toast.getToasts().filter(value => String(value.id) === toastId) as ToastT[];
    reconcileNativeSinkFeedback(toasts());
    child = "card-b";
    reconcileNativeSinkFeedback(toasts());
    expect(show).not.toHaveBeenCalled();
    expect(isNativeSinkFeedback(toastId)).toBe(true);
    childOpen = false;
    reconcileNativeSinkFeedback(toasts());
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(route, expect.objectContaining({ id: toastId, message: "Card saved.", tone: "success" }));
    hide.mockClear();
    route = "owner-b:wallet-visit";
    reconcileNativeSinkFeedback(toasts());
    expect(isNativeSinkFeedback(toastId)).toBe(false);
    expect(hide).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledWith("owner-a:wallet-visit", toastId);
    reconcileNativeSinkFeedback(toasts());
    expect(show).toHaveBeenCalledTimes(1);
  } finally { releaseSink(); releaseConsumer(); if (toastId) toast.dismiss(toastId); }
});

it("keeps the latest-created workspace notification when promises settle in reverse", async () => {
  const route = "owner-a:wallet-visit";
  const show = vi.fn(), hide = vi.fn();
  const releaseConsumer = retainNativeFeedbackConsumer();
  const releaseSink = retainNativeFeedbackSink({ capture: () => route, ready: () => true, show, hide });
  const older = Promise.withResolvers<boolean>();
  const newer = Promise.withResolvers<boolean>();
  let olderId: string | undefined;
  let newerId: string | undefined;
  try {
    const olderHandle = withNativeFeedbackScope("workspace", () => morphyToast.promise(older.promise, {
      loading: "Older pending", success: "Older result", error: "Older failed",
    }));
    olderId = String(olderHandle.valueOf());
    const newerHandle = withNativeFeedbackScope("workspace", () => morphyToast.promise(newer.promise, {
      loading: "Newer pending", success: "Newer result", error: "Newer failed",
    }));
    newerId = String(newerHandle.valueOf());

    expect(olderId).not.toBe(newerId);
    expect(hide).toHaveBeenCalledOnce();
    expect(hide).toHaveBeenCalledWith(route, olderId);
    expect(isNativeSinkFeedback(olderId)).toBe(true);

    const reconcile = () => reconcileNativeSinkFeedback(toast.getToasts() as ToastT[]);
    reconcile();
    expect(show).toHaveBeenLastCalledWith(route, expect.objectContaining({ id: newerId, message: "Newer pending" }));

    newer.resolve(true);
    await newerHandle.unwrap();
    reconcile();
    expect(show).toHaveBeenLastCalledWith(route, expect.objectContaining({ id: newerId, message: "Newer result" }));

    older.resolve(true);
    await olderHandle.unwrap();
    reconcile();
    expect(show.mock.calls.map(([, message]) => message.id)).not.toContain(olderId);
    expect(show).toHaveBeenLastCalledWith(route, expect.objectContaining({ id: newerId, message: "Newer result" }));
    expect(isNativeSinkFeedback(olderId)).toBe(false);
  } finally {
    releaseSink(); releaseConsumer();
    if (olderId) toast.dismiss(olderId);
    if (newerId) toast.dismiss(newerId);
  }
});

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NativeDrawerProjection } from "@/lib/capacitor/native-drawers";
import { nativeFeedbackOptions, nativeFeedbackToast, reconcileNativeFeedback, refreshNativeFeedback, receiveNativeFeedbackAction, receiveNativeFeedbackEnd, retainNativeFeedbackConsumer, retainNativeFeedbackOwner, retainNativeFeedbackForm, retargetNativeSinkToastToWeb, type NativeFeedbackProjection } from "@/lib/capacitor/native-feedback";
import { NativeFeedbackToaster } from "@/components/app-ui/native-feedback-toaster";
import { toast, Toaster as Sonner, type ToastT } from "sonner";
import { setNativeShellFeedbackAvailable } from "@/lib/capacitor/native-workspace-presence";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { activateNativeSinkFeedback, dismissNativeSinkFeedback, nativeSinkFeedbackOptions, reconcileNativeSinkFeedback,
  retainNativeFeedbackSink, withNativeFeedbackScope } from "@/lib/capacitor/native-feedback-sink";
import { workspaceChoiceDomainAllowed, type NativeWorkspaceChoice, type NativeWorkspaceProjection } from "@/lib/capacitor/native-workspace";

type TestNativeFeedbackOwner = Omit<Parameters<typeof retainNativeFeedbackOwner>[0], "parentRetired"> & {
  parentRetired?: () => boolean;
};
function retainTestFeedbackOwner(owner: TestNativeFeedbackOwner) {
  return retainNativeFeedbackOwner({ ...owner, parentRetired: owner.parentRetired ?? (() => true) });
}

const privacy = vi.hoisted(() => ({ state: { generation: 0, shielded: false, appIsActive: true, cause: "inactive" as const } }));
function feedbackEnd(state: NativeFeedbackProjection, endReason: "user" | "expired" | "programmatic") {
  const { message: _message, tone: _tone, duration: _duration, dismissible: _dismissible,
    actionToken: _actionToken, actionLabel: _actionLabel, ...identity } = state;
  return { ...identity, endReason };
}
function feedbackAction(state: NativeFeedbackProjection, actionToken: "open-conversation" | "open-information-request") {
  const { message: _message, tone: _tone, duration: _duration, dismissible: _dismissible,
    actionToken: _actionToken, actionLabel: _actionLabel, ...identity } = state;
  return { ...identity, actionToken };
}
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyCanInteract: (state = privacy.state) => state.appIsActive && !state.shielded,
  nativePrivacyObservation: () => ({ state: privacy.state, epoch: 0 }),
  subscribeNativePrivacyObservation: () => () => undefined,
}));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => true }));

describe("private native feedback lifecycle", () => {
  it("moves a retiring workspace promise to shell feedback without a Web replay", async () => {
    const state = { documentId: "handoff-document", ownerEpoch: "handoff-owner", ownerGeneration: 1,
      revision: 1, family: "shell" as const, updateSequence: 1, privacyGeneration: 0, appearance: "light" as const,
      accentHex: "#007aff", foregroundHex: "#111111", title: "", sections: [], open: true, enabled: true, backEnabled: false };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback: async () => ({ retired: true }), addListener: async () => ({ remove: async () => undefined }) } });
    const releaseSink = retainNativeFeedbackSink({ capture: () => "handoff-workspace", ready: () => true,
      show: () => {}, hide: () => {}, retargetToWeb: retargetNativeSinkToastToWeb });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    const pending = Promise.withResolvers<boolean>();
    try {
      setNativeShellFeedbackAvailable(true);
      const handle = morphyToast.promise(pending.promise, { loading: "Pending handoff", success: "Handoff complete", error: "Handoff failed" });
      await waitFor(() => expect(toast.getToasts().some(value => value.title === "Pending handoff")).toBe(true));
      releaseSink(true);
      refreshNativeFeedback();
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      expect(applyFeedback.mock.calls[0][0].tone).toBe("loading");
      pending.resolve(true); await handle.unwrap();
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      const settled = applyFeedback.mock.calls[1][0];
      expect(settled.feedbackId).toBe(applyFeedback.mock.calls[0][0].feedbackId);
      expect(settled).toMatchObject({ family: "shell", message: "Handoff complete", tone: "success" });
      expect(screen.queryByText("Handoff complete")).toBeNull();
      receiveNativeFeedbackEnd(feedbackEnd(settled, "programmatic"));
    } finally { pending.resolve(true); setNativeShellFeedbackAvailable(false); releaseSink(); releaseOwner(); view.unmount(); }
  });
  it("adopts ordinary shell text without changing its tone, duration or dismissal callback", async () => {
    const state = { documentId: "shell-document", ownerEpoch: "shell-owner", ownerGeneration: 1,
      revision: 1, family: "shell" as const, updateSequence: 1, privacyGeneration: 0, appearance: "light" as const,
      accentHex: "#007aff", foregroundHex: "#111111", title: "", sections: [], open: true, enabled: true, backEnabled: false };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const onDismiss = vi.fn();
    const release = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback: async () => ({ retired: true }), addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let id: string | number | undefined;
    try {
      setNativeShellFeedbackAvailable(true);
      id = toast.success("Saved", { description: "Your changes are ready", duration: 4500, icon: <span>OK</span>, onDismiss });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      const projection = applyFeedback.mock.calls[0][0];
      expect(projection).toMatchObject({ family: "shell", tone: "success", duration: 4500, message: "Saved Your changes are ready" });
      expect(screen.queryByText("Saved")).toBeNull();
      receiveNativeFeedbackEnd(feedbackEnd(projection, "user"));
      receiveNativeFeedbackEnd(feedbackEnd(projection, "user"));
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally { setNativeShellFeedbackAvailable(false); if (id !== undefined) toast.dismiss(id); release(); view.unmount(); }
  });
  it("keeps the actual Sonner promise on one native handle without a DOM duplicate", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const release = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      const pending = Promise.withResolvers<boolean>();
      const operation = vi.fn(() => pending.promise);
      const handle = morphyToast.promise(operation, { loading: "Public save pending", success: "Public save complete", error: "Public save failed" });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      expect(screen.queryByText("Public save pending")).toBeNull();
      pending.resolve(true);
      await handle.unwrap();
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      expect(operation).toHaveBeenCalledOnce();
      const last = applyFeedback.mock.calls[1][0];
      expect(last.feedbackId).toBe(applyFeedback.mock.calls[0][0].feedbackId);
      expect(last.message).toBe("Public save complete");
      expect(screen.queryByText("Public save complete")).toBeNull();
      receiveNativeFeedbackEnd(feedbackEnd(last, "programmatic"));
      await waitFor(() => expect(toast.getToasts().some(t => t.id === last.feedbackId)).toBe(false));
      let featureCurrent = true;
      const stale = Promise.withResolvers<boolean>();
      const staleHandle = morphyToast.promise(stale.promise, { loading: "Public pending result", success: "Must not appear",
        error: "Must not appear", isCurrent: () => featureCurrent });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(3));
      featureCurrent = false;
      stale.resolve(true);
      await staleHandle.unwrap();
      const staleID = applyFeedback.mock.calls[2][0].feedbackId;
      await waitFor(() => expect(toast.getToasts().some(t => t.id === staleID)).toBe(false));
      expect(applyFeedback).toHaveBeenCalledTimes(3);
    } finally { release(); view.unmount(); privacy.state = initialPrivacy; }
  });
  it("coalesces settlement behind compatible admission and preserves the distinct form identity", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    let admitted = false;
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const consumer = retainNativeFeedbackConsumer();
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => admitted,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const form = retainNativeFeedbackForm({ identity: { ...state, revision: 9 }, scene: "writing-style",
      destinationId: "preferences-visit", current: () => true, ready: () => admitted });
    try {
      const options = nativeFeedbackOptions("Saving…")!;
      reconcileNativeFeedback([{ ...options, title: "Saving…", type: "loading" }]);
      reconcileNativeFeedback([{ ...options, title: "Saved", type: "success" }]);
      expect(applyFeedback).not.toHaveBeenCalled();
      expect(retireFeedback).not.toHaveBeenCalled();
      admitted = true;
      refreshNativeFeedback();
      await Promise.resolve();
      expect(applyFeedback).toHaveBeenCalledOnce();
      expect(applyFeedback.mock.calls[0][0]).toMatchObject({ message: "Saved", revision: 1, formRevision: 9, formScene: "writing-style" });
      admitted = false;
      const dismissed = nativeFeedbackOptions("Another save")!;
      reconcileNativeFeedback([{ ...dismissed, title: "Another save", type: "loading" }]);
      reconcileNativeFeedback([]);
      admitted = true;
      reconcileNativeFeedback([{ ...dismissed, title: "Late result", type: "success" }]);
      expect(applyFeedback).toHaveBeenCalledOnce();
    } finally { form(); owner(); consumer(); privacy.state = initialPrivacy; }
  });
  it("updates one notification, rejects old expiry, and never replays after privacy or owner retirement", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    let current = true;
    const releaseConsumer = retainNativeFeedbackConsumer();
    const releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => current,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    try {
      const options = nativeFeedbackOptions("Saving…")!;
      expect(options).toBeDefined();
      const loading = { ...options, title: "Saving…", type: "loading" as const };
      reconcileNativeFeedback([loading]);
      await Promise.resolve();
      const first = applyFeedback.mock.calls[0][0];
      expect(first).toMatchObject({ feedbackId: options.id, tone: "loading", duration: 0 });
      reconcileNativeFeedback([{ ...loading, title: "Saved", type: "success" }]);
      await Promise.resolve();
      const second = applyFeedback.mock.calls[1][0];
      expect(second.feedbackId).toBe(first.feedbackId);
      expect(second.feedbackRevision).toBe(first.feedbackRevision + 1);
      const end = (projection: NativeFeedbackProjection) => feedbackEnd(projection, "programmatic");
      receiveNativeFeedbackEnd(end(first));
      expect(retireFeedback).not.toHaveBeenCalled();
      receiveNativeFeedbackEnd({ ...end(second), ownerEpoch: "stale-owner" });
      expect(retireFeedback).not.toHaveBeenCalled();
      privacy.state = { ...privacy.state, generation: 1, shielded: true };
      reconcileNativeFeedback([{ ...loading, title: "Saved", type: "success" }]);
      expect(retireFeedback).toHaveBeenCalledOnce();
      privacy.state = { ...initialPrivacy, generation: 0, shielded: false, appIsActive: true };
      current = false;
      reconcileNativeFeedback([{ ...loading, title: "Late result", type: "success" }]);
      expect(applyFeedback).toHaveBeenCalledTimes(2);
      expect(nativeFeedbackOptions("After owner change")).toBeUndefined();
    } finally { releaseOwner(); releaseConsumer(); privacy.state = initialPrivacy; }
  });

  it("leaves rich feedback on its authored renderer and retires a notification when its destination changes", () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    let state: NativeDrawerProjection = { documentId: "public-feedback", ownerEpoch: "public-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "first-visit" };
    const applyFeedback = vi.fn(async () => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const consumer = retainNativeFeedbackConsumer();
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    try {
      expect(nativeFeedbackOptions(<strong>Rich authored message</strong>)).toBeUndefined();
      const options = nativeFeedbackOptions("Saving…")!;
      reconcileNativeFeedback([{ ...options, title: "Saving…", type: "loading" }]);
      state = { ...state, profileDestinationId: "replacement-visit" };
      reconcileNativeFeedback([{ ...options, title: "Saved", type: "success" }]);
      expect(applyFeedback).toHaveBeenCalledOnce();
      expect(retireFeedback).toHaveBeenCalledOnce();
    } finally { owner(); consumer(); privacy.state = initialPrivacy; }
  });

  it("routes opted-in dynamic text promise outcomes through one native handle", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      const successMessage = vi.fn((value: number) => `Saved version ${value}.`);
      const success = Promise.withResolvers<number>();
      const successToast = morphyToast.promiseText(success.promise, {
        loading: "Saving version…", success: successMessage, error: () => "Could not save version.", isCurrent: () => true,
      });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      expect(screen.queryByText("Saving version…")).toBeNull();
      success.resolve(4);
      await successToast.unwrap();
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      expect(successMessage).toHaveBeenCalledOnce();
      expect(successMessage).toHaveBeenCalledWith(4);
      const successProjection = applyFeedback.mock.calls[1][0];
      expect(successProjection).toMatchObject({
        feedbackId: applyFeedback.mock.calls[0][0].feedbackId,
        message: "Saved version 4.",
        tone: "success",
      });
      expect(screen.queryByText("Saved version 4.")).toBeNull();
      receiveNativeFeedbackEnd(feedbackEnd(successProjection, "programmatic"));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successProjection.feedbackId)).toBe(false));

      const errorMessage = vi.fn((cause: unknown) => `Update failed: ${(cause as Error).message}`);
      const failure = Promise.withResolvers<number>();
      const errorToast = morphyToast.promiseText(failure.promise, {
        loading: "Updating version…", success: () => "Unexpected success.", error: errorMessage, isCurrent: () => true,
      });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(3));
      const cause = new Error("unavailable");
      failure.reject(cause);
      await expect(errorToast.unwrap()).rejects.toBe(cause);
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(4));
      expect(errorMessage).toHaveBeenCalledOnce();
      expect(errorMessage).toHaveBeenCalledWith(cause);
      const errorProjection = applyFeedback.mock.calls[3][0];
      expect(errorProjection).toMatchObject({ message: "Update failed: unavailable", tone: "error" });
      expect(screen.queryByText("Update failed: unavailable")).toBeNull();
      receiveNativeFeedbackEnd(feedbackEnd(errorProjection, "programmatic"));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === errorProjection.feedbackId)).toBe(false));
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("dismisses null and empty text outcomes without publishing an empty native banner", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      for (const [index, result] of ([null, "   "] as const).entries()) {
        const pending = Promise.withResolvers<boolean>();
        const handle = morphyToast.promiseText(pending.promise, {
          loading: `Saving optional result ${index}…`, success: () => result, error: () => result, isCurrent: () => true,
        });
        const callCount = index + 1;
        await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(callCount));
        const loadingId = applyFeedback.mock.calls[callCount - 1][0].feedbackId;
        pending.resolve(true);
        await handle.unwrap();
        await waitFor(() => expect(toast.getToasts().some(value => value.id === loadingId)).toBe(false));
        expect(applyFeedback).toHaveBeenCalledTimes(callCount);
        expect(retireFeedback).toHaveBeenCalledTimes(callCount);
      }
      expect(screen.queryByText(/Saving optional result/)).toBeNull();
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps dynamic text promises on Morphy's DOM renderer when no native owner is active", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      const pending = Promise.withResolvers<number>();
      const handle = morphyToast.promiseText(pending.promise, {
        loading: "Saving in WebView…", success: value => `Web saved ${value}.`, error: () => "Web save failed.", isCurrent: () => true,
      });
      expect(await screen.findByText("Saving in WebView…")).toBeTruthy();
      pending.resolve(8);
      await handle.unwrap();
      expect(await screen.findByText("Web saved 8.")).toBeTruthy();
      expect(screen.getByText("Web saved 8.").closest("[data-sonner-toast]")?.className).toContain("morphy-sonner-toast");
      const id = handle.valueOf();
      if (typeof id === "number" || typeof id === "string") toast.dismiss(id);
    } finally { view.unmount(); privacy.state = initialPrivacy; }
  });

  it("releases a Wallet sink banner while preserving a rich promise fallback and its Sonner ID", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const show = vi.fn(), hide = vi.fn();
    const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? "wallet-rich-owner" : null,
      ready: () => true, show, hide });
    const view = render(<><NativeFeedbackToaster /><Sonner closeButton /></>);
    try {
      const pending = Promise.withResolvers<boolean>();
      const handle = withNativeFeedbackScope("workspace", () => nativeFeedbackToast.promiseText(pending.promise, {
        loading: "Saving a rich result…",
        success: () => <strong>Rich Wallet result saved.</strong> as unknown as string,
        error: () => "Wallet save failed.", closeButton: true,
      }));
      await waitFor(() => expect(show).toHaveBeenCalledOnce());
      const id = handle.valueOf();
      expect(typeof id === "number" || typeof id === "string").toBe(true);
      pending.resolve(true);
      await handle.unwrap();
      expect(await screen.findByText("Rich Wallet result saved.")).toBeTruthy();
      await waitFor(() => expect(hide).toHaveBeenCalledOnce());
      expect(toast.getToasts().find(value => value.id === id)).toMatchObject({ toasterId: undefined, closeButton: true });
      fireEvent.click(screen.getByRole("button", { name: "Close toast" }));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === id)).toBe(false));
    } finally { releaseSink(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("retires a Wallet sink action before it posts a same-ID successor", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const show = vi.fn(), hide = vi.fn();
    const logicalId = "wallet-action-successor";
    let successorHandle: string | number | undefined;
    const onAction = vi.fn(() => {
      successorHandle = withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("Wallet successor notice", {
        id: logicalId, duration: Infinity,
      }));
    });
    const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? "wallet-action-successor-owner" : null,
      ready: () => true, show, hide });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("Wallet action notice", {
        id: logicalId, duration: Infinity,
        action: { token: "open-conversation", label: "Open", onClick: onAction },
      }));
      await waitFor(() => expect(show).toHaveBeenCalledOnce());
      const originalToast = toast.getToasts().find(value => value.title === "Wallet action notice");
      if (!originalToast) throw new Error("Original Wallet action toast was not created");

      expect(activateNativeSinkFeedback(String(originalToast.id), "open-conversation")).toBe(true);
      expect(onAction).toHaveBeenCalledOnce();
      expect(successorHandle).toBe(logicalId);
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
      const successorToast = toast.getToasts().find(value => value.title === "Wallet successor notice");
      if (!successorToast) throw new Error("Wallet action successor toast was not created");
      expect(successorToast.id).not.toBe(originalToast.id);
      expect(successorToast.toasterId).toBe("native-owned-feedback");

      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(true));
      expect(toast.getToasts().some(value => value.id === originalToast.id)).toBe(false);
      expect(activateNativeSinkFeedback(String(originalToast.id), "open-conversation")).toBe(false);
      expect(onAction).toHaveBeenCalledOnce();

      dismissNativeSinkFeedback(String(successorToast.id));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(false));
    } finally { releaseSink(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps non-opted-in rich promise outcomes on the authored DOM renderer", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      const pending = Promise.withResolvers<boolean>();
      const handle = morphyToast.promise(pending.promise, {
        loading: "Saving rich result…", success: () => <strong>Rich result saved.</strong>, error: "Rich result failed.",
      });
      expect(await screen.findByText("Saving rich result…")).toBeTruthy();
      pending.resolve(true);
      await handle.unwrap();
      expect(await screen.findByText("Rich result saved.")).toBeTruthy();
      expect(applyFeedback).not.toHaveBeenCalled();
      const id = handle.valueOf();
      if (typeof id === "number" || typeof id === "string") toast.dismiss(id);
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("retires an unobserved native entry after Sonner hands the toast to its DOM renderer", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const consumer = retainNativeFeedbackConsumer();
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<Sonner />);
    const options = nativeFeedbackOptions("Saving rich result…")!;
    try {
      toast.success(<strong>Rich result settled before native observation.</strong>, { id: options.id, toasterId: undefined });
      reconcileNativeFeedback(toast.getToasts());
      expect(retireFeedback).toHaveBeenCalledOnce();
      expect(retireFeedback.mock.calls[0][0]).toMatchObject({ feedbackId: options.id });
      expect(applyFeedback).not.toHaveBeenCalled();
      expect(toast.getToasts().some(value => value.id === options.id)).toBe(true);
      expect(await screen.findByText("Rich result settled before native observation.")).toBeTruthy();
    } finally {
      toast.dismiss(options.id);
      owner(); consumer(); view.unmount(); privacy.state = initialPrivacy;
    }
  });

  it("routes an adapter notice to its active native owner and forwards user dismissal once", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "notice-document", ownerEpoch: "notice-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const onDismiss = vi.fn();
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOwner = () => undefined;
    try {
      releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
        plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
      nativeFeedbackToast.noticeText("One is still connecting.", {
        id: "one-chat-slow-notice-test", duration: Infinity, closeButton: true, dismissible: true,
        onDismiss,
      }, "message");
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      const first = applyFeedback.mock.calls[0][0];
      expect(first.feedbackId).toBe("one-chat-slow-notice-test");
      expect(toast.getToasts().find(value => value.id === first.feedbackId)?.toasterId).toBe("native-owned-feedback");
      expect(screen.queryByText("One is still connecting.")).toBeNull();

      nativeFeedbackToast.noticeText("Still connecting to One.", {
        id: "one-chat-slow-notice-test", duration: Infinity, closeButton: true, dismissible: true,
        onDismiss,
      }, "message");
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      const updated = applyFeedback.mock.calls[1][0];
      expect(updated.feedbackId).toBe(first.feedbackId);
      expect(updated.feedbackRevision).toBe(first.feedbackRevision + 1);
      expect(updated.message).toBe("Still connecting to One.");
      expect(screen.queryByText("Still connecting to One.")).toBeNull();

      receiveNativeFeedbackEnd(feedbackEnd(updated, "user"));
      await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
      toast.dismiss(updated.feedbackId); // A delayed Sonner store dismissal shares the same once-only wrapper.
      expect(onDismiss).toHaveBeenCalledOnce();
      receiveNativeFeedbackEnd(feedbackEnd(updated, "user"));
      expect(onDismiss).toHaveBeenCalledOnce();
      await waitFor(() => expect(toast.getToasts().some(value => value.id === updated.feedbackId)).toBe(false));
    } finally { releaseOwner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("maps opted decorative icons to native tone while older raw notices retain their renderer", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "icon-notice-document", ownerEpoch: "icon-notice-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const icon = <span data-testid="authored-feedback-icon">Sync</span>;
    const preexistingId = "preexisting-icon-notice";
    const optedId = "opted-icon-notice";
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOwner = () => undefined;
    try {
      toast.success("Pre-existing icon notice", { id: preexistingId, duration: Infinity, icon });
      expect(await screen.findByText("Pre-existing icon notice")).toBeTruthy();
      releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
        plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
      const preexisting = toast.getToasts().find(value => value.id === preexistingId);
      if (!preexisting) throw new Error("Pre-existing icon toast was not created");
      reconcileNativeFeedback([preexisting]);

      nativeFeedbackToast.noticeText("Opted icon notice", { id: optedId, duration: Infinity, icon });
      const genericId = nativeFeedbackToast.success("Generic icon notice", { duration: Infinity, icon });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      expect(applyFeedback.mock.calls[0][0].message).toBe("Opted icon notice");
      expect(screen.queryByText("Opted icon notice")).toBeNull();
      expect(await screen.findByText("Generic icon notice")).toBeTruthy();
      expect(screen.getAllByTestId("authored-feedback-icon")).toHaveLength(2);
      expect(toast.getToasts().find(value => value.id === preexistingId)?.toasterId).toBeUndefined();
      expect(toast.getToasts().find(value => value.id === optedId)?.toasterId).toBe("native-owned-feedback");
      expect(toast.getToasts().find(value => value.id === genericId)?.toasterId).toBeUndefined();
      expect(toast.getToasts().find(value => value.id === preexistingId)?.icon).toBe(icon);
      expect(toast.getToasts().find(value => value.id === optedId)?.icon).toBe(icon);
      expect(toast.getToasts().find(value => value.id === genericId)?.icon).toBe(icon);
      const numericZero = { id: 0, title: "Numeric zero stays in Web", type: "success", duration: Infinity } satisfies ToastT;
      const toastSuccess = vi.spyOn(toast, "success").mockImplementation(() => 0);
      try {
        reconcileNativeFeedback([numericZero]);
        expect(toastSuccess).not.toHaveBeenCalled();
        expect(toast.getToasts().some(value => value.id === 0)).toBe(false);
      } finally { toastSuccess.mockRestore(); }
      expect(applyFeedback).toHaveBeenCalledOnce();

      toast.dismiss(preexistingId); toast.dismiss(optedId); toast.dismiss(genericId);
      await waitFor(() => expect(toast.getToasts().some(value =>
        value.id === preexistingId || value.id === optedId || value.id === genericId)).toBe(false));
    } finally { releaseOwner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps Web-owned notices on Web when a native owner appears", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "web-callback-document", ownerEpoch: "web-callback-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const onDismiss = vi.fn((_value?: ToastT) => undefined);
    const rawId = "plain-web-callback-raw";
    const optedId = "plain-web-callback-opted";
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOwner = () => undefined;
    try {
      toast.success("Pre-existing Web notice", { id: rawId, duration: Infinity });
      nativeFeedbackToast.noticeText("Web-owned adapter notice", { id: optedId, duration: Infinity, onDismiss }, "message");
      expect(await screen.findByText("Pre-existing Web notice")).toBeTruthy();
      expect(await screen.findByText("Web-owned adapter notice")).toBeTruthy();
      expect(toast.getToasts().find(value => value.id === rawId)?.toasterId).toBeUndefined();
      expect(toast.getToasts().find(value => value.id === optedId)?.toasterId).toBeUndefined();
      releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
        plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(applyFeedback).not.toHaveBeenCalled();
      expect(toast.getToasts().find(value => value.id === rawId)?.toasterId).toBeUndefined();
      expect(toast.getToasts().find(value => value.id === optedId)?.toasterId).toBeUndefined();
      expect(screen.getByText("Pre-existing Web notice")).toBeTruthy();
      expect(screen.getByText("Web-owned adapter notice")).toBeTruthy();

      toast.dismiss(optedId);
      await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
      const callbackToast = onDismiss.mock.calls[0]?.[0];
      expect(callbackToast?.id).toBe(optedId);
      expect(callbackToast?.toasterId).toBeUndefined();
      toast.dismiss(rawId);
    } finally { releaseOwner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("retires a native notice before its dismissal callback posts a same-ID successor", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "sync-successor-document", ownerEpoch: "sync-successor-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const successorDismiss = vi.fn();
    const logicalId = "sync-callback-successor";
    let successorHandle: string | number | undefined;
    const onDismiss = vi.fn(() => {
      successorHandle = nativeFeedbackToast.noticeText("Successor notice", {
        id: logicalId, duration: Infinity, onDismiss: successorDismiss,
      });
    });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOwner = () => undefined;
    try {
      releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
        plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
      nativeFeedbackToast.noticeText("Original notice", { id: logicalId, duration: Infinity, onDismiss });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      const original = applyFeedback.mock.calls[0][0];
      const originalToast = toast.getToasts().find(value => value.title === "Original notice");
      expect(originalToast?.id).toBe(logicalId);

      receiveNativeFeedbackEnd(feedbackEnd(original, "user"));
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(successorHandle).toBe(logicalId);
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      const successorProjection = applyFeedback.mock.calls[1][0];
      const successorToast = toast.getToasts().find(value => value.title === "Successor notice");
      if (!successorToast) throw new Error("Same-ID successor toast was not created");
      expect(successorToast.id).not.toBe(originalToast?.id);
      expect(successorToast.toasterId).toBe("native-owned-feedback");

      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(true));
      expect(toast.getToasts().some(value => value.id === originalToast?.id)).toBe(false);
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(successorDismiss).not.toHaveBeenCalled();
      receiveNativeFeedbackEnd(feedbackEnd(original, "user"));
      expect(retireFeedback).toHaveBeenCalledOnce();
      expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(true);

      receiveNativeFeedbackEnd(feedbackEnd(successorProjection, "programmatic"));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(false));
      expect(successorDismiss).not.toHaveBeenCalled();
    } finally { releaseOwner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("retires native ownership before an action posts a same-ID successor", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "action-successor-document", ownerEpoch: "action-successor-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const logicalId = "action-callback-successor";
    let successorHandle: string | number | undefined;
    const onAction = vi.fn(() => {
      expect(retireFeedback).toHaveBeenCalledOnce();
      successorHandle = nativeFeedbackToast.noticeText("Action successor notice", { id: logicalId, duration: Infinity });
    });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOwner = () => undefined;
    try {
      releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
        plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
      nativeFeedbackToast.noticeText("Original action notice", { id: logicalId, duration: Infinity,
        action: { token: "open-conversation", label: "Open", onClick: onAction } });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      const original = applyFeedback.mock.calls[0][0];
      const originalToast = toast.getToasts().find(value => value.title === "Original action notice");
      if (!originalToast) throw new Error("Original action toast was not created");

      receiveNativeFeedbackAction(feedbackAction(original, "open-conversation"));
      expect(onAction).toHaveBeenCalledOnce();
      expect(successorHandle).toBe(logicalId);
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      const successorProjection = applyFeedback.mock.calls[1][0];
      const successorToast = toast.getToasts().find(value => value.title === "Action successor notice");
      if (!successorToast) throw new Error("Action successor toast was not created");
      expect(successorToast.id).not.toBe(originalToast.id);
      expect(successorToast.toasterId).toBe("native-owned-feedback");

      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(true));
      expect(toast.getToasts().some(value => value.id === originalToast.id)).toBe(false);
      expect(onAction).toHaveBeenCalledOnce();
      receiveNativeFeedbackAction(feedbackAction(original, "open-conversation"));
      expect(onAction).toHaveBeenCalledOnce();

      receiveNativeFeedbackEnd(feedbackEnd(successorProjection, "programmatic"));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successorToast.id)).toBe(false));
    } finally { releaseOwner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("claims an opted-in notice before native owner readiness without flashing it in Web", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "admission-document", ownerEpoch: "admission-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    let ready = false;
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => ready,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      nativeFeedbackToast.noticeText("One replied", { id: "admission-one-reply", description: "Your answer is ready.",
        action: { token: "open-conversation", label: "Open", onClick: vi.fn() } });
      expect(toast.getToasts().find(value => value.id === "admission-one-reply")?.toasterId).toBe("native-owned-feedback");
      expect(screen.queryByText("One replied")).toBeNull();
      reconcileNativeFeedback(toast.getToasts());
      expect(applyFeedback).not.toHaveBeenCalled();

      ready = true;
      reconcileNativeFeedback(toast.getToasts());
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      expect(applyFeedback.mock.calls[0][0]).toMatchObject({ message: "One replied Your answer is ready.", actionToken: "open-conversation", actionLabel: "Open" });
      expect(screen.queryByText("One replied")).toBeNull();
      nativeFeedbackToast.dismiss("admission-one-reply");
      await waitFor(() => expect(toast.getToasts().some(value => value.id === "admission-one-reply")).toBe(false));
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps Wallet feedback hidden during admission, then restores the same promise to Web on refusal", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const show = vi.fn(), hide = vi.fn();
    const releaseSink = retainNativeFeedbackSink({ capture: () => "wallet-admission", ready: () => false, show, hide,
      retargetToWeb: retargetNativeSinkToastToWeb });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let toastId: string | number | undefined;
    try {
      const pending = Promise.withResolvers<boolean>();
      const handle = morphyToast.promise(pending.promise, { loading: "Wallet save pending…",
        success: "Wallet save complete.", error: "Wallet save failed." });
      const id = handle.valueOf();
      toastId = typeof id === "string" || typeof id === "number" ? id : undefined;
      expect(typeof id === "string" || typeof id === "number").toBe(true);
      await waitFor(() => expect(toast.getToasts().find(value => value.id === id)?.toasterId).toBe("native-owned-feedback"));
      expect(screen.queryByText("Wallet save pending…")).toBeNull();

      releaseSink(true);
      expect(await screen.findByText("Wallet save pending…")).toBeTruthy();
      expect(toast.getToasts().find(value => value.id === id)?.toasterId).toBeUndefined();
      pending.resolve(true);
      await handle.unwrap();
      expect(await screen.findByText("Wallet save complete.")).toBeTruthy();
      expect(toast.getToasts().find(value => value.id === id)?.toasterId).toBeUndefined();
      expect(show).not.toHaveBeenCalled();
    } finally { if (toastId !== undefined) toast.dismiss(toastId); releaseSink(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("does not treat a programmatic clear as a person dismissal", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "clear-document", ownerEpoch: "clear-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const onDismiss = vi.fn();
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      nativeFeedbackToast.noticeText("One is taking longer than usual.", {
        id: "slow-clear-test", duration: Infinity, closeButton: true, onDismiss,
      }, "message");
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      toast.dismiss("slow-clear-test");
      await waitFor(() => expect(retireFeedback).toHaveBeenCalledOnce());
      expect(onDismiss).not.toHaveBeenCalled();
      expect(applyFeedback).toHaveBeenCalledOnce();
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("runs a native notice action only for the current owner and feedback revision", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const initialState: NativeDrawerProjection = { documentId: "action-document", ownerEpoch: "action-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    let state = initialState;
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const openConversation = vi.fn();
    const staleOpen = vi.fn();
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      nativeFeedbackToast.noticeText("One replied", { id: "one-reply-current", description: "Your answer is ready.",
        action: { token: "open-conversation", label: "Open", onClick: openConversation } });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      const current = applyFeedback.mock.calls[0][0];
      receiveNativeFeedbackAction({ ...feedbackAction(current, "open-conversation"), feedbackRevision: current.feedbackRevision - 1 });
      expect(openConversation).not.toHaveBeenCalled();
      receiveNativeFeedbackAction(feedbackAction(current, "open-conversation"));
      receiveNativeFeedbackAction(feedbackAction(current, "open-conversation"));
      expect(openConversation).toHaveBeenCalledOnce();
      await waitFor(() => expect(toast.getToasts().some(value => value.id === current.feedbackId)).toBe(false));

      nativeFeedbackToast.noticeText("One replied", { id: "one-reply-stale-owner", description: "Your answer is ready.",
        action: { token: "open-conversation", label: "Open", onClick: staleOpen } });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledTimes(2));
      const stale = applyFeedback.mock.calls[1][0];
      state = { ...state, ownerEpoch: "replacement-owner" };
      receiveNativeFeedbackAction(feedbackAction(stale, "open-conversation"));
      expect(staleOpen).not.toHaveBeenCalled();
      nativeFeedbackToast.dismiss(stale.feedbackId);
      await waitFor(() => expect(toast.getToasts().some(value => value.id === stale.feedbackId)).toBe(false));
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps the authored Web Sonner icon, description, action and dismiss callbacks", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const openConversation = vi.fn();
    const onDismiss = vi.fn();
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      nativeFeedbackToast.noticeText("One replied", { id: "web-one-reply", description: "Your answer is ready.",
        action: { token: "open-conversation", label: "Open", onClick: openConversation } });
      expect(await screen.findByText("One replied")).toBeTruthy();
      expect(screen.getByText("Your answer is ready.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      expect(openConversation).toHaveBeenCalledOnce();
      toast.dismiss("web-one-reply");
      await waitFor(() => expect(toast.getToasts().some(value => value.id === "web-one-reply")).toBe(false));

      nativeFeedbackToast.noticeText("One is still connecting.", {
        id: "web-slow-notice", duration: Infinity, closeButton: true, dismissible: true,
        icon: <span data-testid="web-slow-icon">Sync</span>, onDismiss,
      }, "message");
      expect(await screen.findByText("One is still connecting.")).toBeTruthy();
      expect(screen.getByTestId("web-slow-icon")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close toast" }));
      await waitFor(() => expect(onDismiss).toHaveBeenCalledOnce());
      await waitFor(() => expect(toast.getToasts().some(value => value.id === "web-slow-notice")).toBe(false));
    } finally { view.unmount(); privacy.state = initialPrivacy; }
  });

  it.each(["open-conversation", "undo-feed-removal"] as const)("routes stable native feedback with its %s action", async token => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    expect(toast.getToasts().filter(value => value.toasterId === undefined).map(value => ({
      id: String(value.id), title: value.title, type: value.type,
    }))).toEqual([]);
    const show = vi.fn();
    const hide = vi.fn();
    const openConversation = vi.fn();
    const onDismiss = vi.fn();
    const onAutoClose = vi.fn();
    const releaseSink = retainNativeFeedbackSink({
      capture: scope => scope === "workspace" ? "wallet-workspace-owner" : null,
      ready: () => true,
      show,
      hide,
    });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      const id = withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("One replied", {
        id: `wallet-one-reply-${token}`, description: "Your answer is ready.",
        action: { token, label: "Open", onClick: openConversation },
        onDismiss, onAutoClose,
      }, token === "undo-feed-removal" ? "success" : "default"));
      expect(id).toBe(`wallet-one-reply-${token}`);
      await waitFor(() => expect(show).toHaveBeenCalledOnce());
      expect(show.mock.calls[0][1]).toMatchObject({ id, message: "One replied Your answer is ready.",
        actionToken: token, actionLabel: "Open", tone: token === "undo-feed-removal" ? "success" : "normal" });
      expect(toast.getToasts().find(value => value.id === id)?.toasterId).toBe("native-owned-feedback");
      expect(activateNativeSinkFeedback(id, token)).toBe(true);
      expect(activateNativeSinkFeedback(id, token)).toBe(false);
      expect(openConversation).toHaveBeenCalledOnce();
      expect(onDismiss).not.toHaveBeenCalled();
      expect(onAutoClose).not.toHaveBeenCalled();
      expect(hide).toHaveBeenCalledOnce();
      expect(toast.getToasts().some(value => value.id === id)).toBe(false);

      const expiredDismiss = vi.fn(), expiredAutoClose = vi.fn();
      const expiredId = withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("Wallet notice expired", {
        id: `wallet-expired-notice-${token}`, duration: Infinity, onDismiss: expiredDismiss, onAutoClose: expiredAutoClose,
      }));
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
      dismissNativeSinkFeedback(expiredId, "expired");
      expect(expiredAutoClose).toHaveBeenCalledOnce();
      expect(expiredDismiss).not.toHaveBeenCalled();

      const userDismiss = vi.fn(), userAutoClose = vi.fn();
      const userId = withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("Wallet notice dismissed", {
        id: `wallet-user-dismissed-notice-${token}`, duration: Infinity, onDismiss: userDismiss, onAutoClose: userAutoClose,
      }));
      await waitFor(() => expect(show).toHaveBeenCalledTimes(3));
      dismissNativeSinkFeedback(userId, "user");
      expect(userDismiss).toHaveBeenCalledOnce();
      expect(userAutoClose).not.toHaveBeenCalled();
    } finally { releaseSink(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps a Wallet banner visible alongside an unrelated Web toast", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    let visibleNativeNotice: string | null = null;
    let webFallbackToastId: string | number | undefined;
    const onDismiss = vi.fn();
    const show = vi.fn((_key: string, feedback: { id: string }) => {
      visibleNativeNotice = feedback.id;
    });
    const hide = vi.fn((_key: string, toastId: string) => { if (visibleNativeNotice === toastId) visibleNativeNotice = null; });
    const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? "wallet-overlap-owner" : null,
      ready: () => true, show, hide });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      const id = withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("Wallet native notice", {
        id: "wallet-overlap-notice", duration: Infinity, onDismiss,
      }));
      await waitFor(() => expect(show).toHaveBeenCalledOnce());
      const webId = toast.success(<strong>Web fallback remains visible</strong>, { duration: Infinity });
      webFallbackToastId = webId;
      expect(await screen.findByText("Web fallback remains visible")).toBeTruthy();
      expect(hide).not.toHaveBeenCalled();
      expect(show).toHaveBeenCalledOnce();
      expect(visibleNativeNotice).toBe(String(id));
      expect(toast.getToasts().some(value => String(value.id) === String(webFallbackToastId))).toBe(true);
      expect(toast.getToasts().find(value => String(value.id) === String(id))?.toasterId).toBe("native-owned-feedback");
      expect(onDismiss).not.toHaveBeenCalled();

      toast.dismiss(webId);
      await waitFor(() => expect(toast.getToasts().some(value => String(value.id) === String(webFallbackToastId))).toBe(false));
      expect(show).toHaveBeenCalledOnce();
      expect(visibleNativeNotice).toBe(String(id));
      expect(toast.getToasts().find(value => String(value.id) === String(id))?.toasterId).toBe("native-owned-feedback");
      expect(onDismiss).not.toHaveBeenCalled();
      dismissNativeSinkFeedback(String(id), "programmatic");
    } finally { releaseSink(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps Wallet expiry independent of an unrelated Web toast", async () => {
    vi.useFakeTimers();
    const id = "wallet-paused-duration-notice";
    const show = vi.fn(), hide = vi.fn(), onEnd = vi.fn();
    const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? "wallet-paused-duration-owner" : null,
      ready: () => true, show, hide });
    try {
      const options = withNativeFeedbackScope("workspace", () => nativeSinkFeedbackOptions({ id, onEnd }));
      if (!options) throw new Error("Wallet feedback sink was not admitted");
      const nativeToast = { id, toasterId: options.toasterId, title: "Timed Wallet notice", type: "success",
        duration: 2000, dismissible: true } satisfies ToastT;
      const webFallback = { id: "wallet-rich-web-fallback", title: <strong>Web fallback</strong>, type: "success",
        duration: Infinity, dismissible: true } satisfies ToastT;

      reconcileNativeSinkFeedback([nativeToast]);
      expect(show).toHaveBeenCalledOnce();
      expect(show.mock.calls[0]?.[1].id).toBe(id);

      await vi.advanceTimersByTimeAsync(600);
      reconcileNativeSinkFeedback([nativeToast, webFallback]);
      expect(hide).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1399);
      expect(onEnd).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onEnd).toHaveBeenCalledWith("expired");
      expect(hide).toHaveBeenCalledOnce();
    } finally {
      releaseSink();
      vi.useRealTimers();
    }
  });

  it("pauses native Wallet expiry while the workspace sink is not ready", async () => {
    vi.useFakeTimers();
    const id = "wallet-unready-duration-notice";
    let ready = true;
    const show = vi.fn(), hide = vi.fn(), onEnd = vi.fn();
    const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? "wallet-unready-duration-owner" : null,
      ready: () => ready, show, hide });
    try {
      const options = withNativeFeedbackScope("workspace", () => nativeSinkFeedbackOptions({ id, onEnd }));
      if (!options) throw new Error("Wallet feedback sink was not admitted");
      const nativeToast = { id, toasterId: options.toasterId, title: "Timed Wallet detail notice", type: "success",
        duration: 2000, dismissible: true } satisfies ToastT;

      reconcileNativeSinkFeedback([nativeToast]);
      expect(show).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(600);
      ready = false;
      reconcileNativeSinkFeedback([nativeToast]);
      expect(hide).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2500);
      expect(onEnd).not.toHaveBeenCalled();

      ready = true;
      reconcileNativeSinkFeedback([nativeToast]);
      expect(show).toHaveBeenCalledTimes(2);
      expect(show.mock.calls[1]?.[1].id).toBe(id);
      await vi.advanceTimersByTimeAsync(1399);
      expect(onEnd).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onEnd).toHaveBeenCalledWith("expired");
      expect(hide).toHaveBeenCalledTimes(2);
    } finally {
      releaseSink();
      vi.useRealTimers();
    }
  });

  it("rotates the physical Sonner ID before a same-logical-ID successor follows an in-flight dismiss", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const show = vi.fn(), hide = vi.fn(), firstDismiss = vi.fn(), nextDismiss = vi.fn();
    const releaseSink = retainNativeFeedbackSink({ capture: scope => scope === "workspace" ? "wallet-race-owner" : null,
      ready: () => true, show, hide });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("First notice", {
        id: "same-logical-notice", duration: Infinity, onDismiss: firstDismiss,
      }));
      await waitFor(() => expect(show).toHaveBeenCalledOnce());
      const firstToast = toast.getToasts().find(value => value.title === "First notice");
      expect(firstToast).toBeDefined();

      nativeFeedbackToast.dismiss("same-logical-notice");
      withNativeFeedbackScope("workspace", () => nativeFeedbackToast.noticeText("Successor notice", {
        id: "same-logical-notice", duration: Infinity, onDismiss: nextDismiss,
      }));
      await waitFor(() => expect(show).toHaveBeenCalledTimes(2));
      const successor = toast.getToasts().find(value => value.title === "Successor notice");
      expect(successor).toBeDefined();
      expect(successor?.id).not.toBe(firstToast?.id);

      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await waitFor(() => expect(toast.getToasts().some(value => value.id === successor?.id)).toBe(true));
      expect(toast.getToasts().some(value => value.id === firstToast?.id)).toBe(false);
      expect(firstDismiss).not.toHaveBeenCalled();
      expect(nextDismiss).not.toHaveBeenCalled();
    } finally { releaseSink(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("admits a Wallet workspace action only for the current notice ID and token", () => {
    const state: NativeWorkspaceProjection = {
      documentId: "wallet-action-document", ownerEpoch: "wallet-action-owner", ownerGeneration: 1, revision: 3,
      workspace: "wallet", updateSequence: 7, privacyGeneration: 2, isolationGeneration: 0,
      frame: { x: 0, y: 0, width: 360, height: 720, viewportWidth: 360, viewportHeight: 800, layoutRevision: 1 },
      appearance: "light", accentHex: "#007aff", foregroundHex: "#111111", page: "overview", title: "Wallet",
      enabled: true, backEnabled: true, sections: [],
      feedback: { id: "wallet-action-notice", message: "One replied", tone: "normal", dismissible: true,
        actionToken: "open-conversation", actionLabel: "Open" },
    };
    const choice: NativeWorkspaceChoice = { ...state, sequence: 1, action: "feedback-action", rowId: state.feedback.id,
      actionToken: "open-conversation", updateSequence: state.updateSequence, privacyGeneration: state.privacyGeneration };
    expect(workspaceChoiceDomainAllowed(choice, state, false)).toBe(true);
    expect(workspaceChoiceDomainAllowed({ ...choice, actionToken: "open-information-request" }, state, false)).toBe(false);
    expect(workspaceChoiceDomainAllowed({ ...choice, rowId: "another-notice" }, state, false)).toBe(false);
    expect(workspaceChoiceDomainAllowed(choice, state, true)).toBe(false);
  });

  it("transfers the same notice to a successor owner before considering Web replay", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const oldState: NativeDrawerProjection = { documentId: "successor-document", ownerEpoch: "old-native-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const nextState: NativeDrawerProjection = { ...oldState, ownerEpoch: "successor-native-owner", revision: 2 };
    let oldCurrent = true;
    const oldApply = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const oldRetire = vi.fn(async () => ({ retired: true }));
    const nextApply = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const nextRetire = vi.fn(async () => ({ retired: true }));
    const onDismiss = vi.fn();
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOld = () => undefined;
    let releaseNext = () => undefined;
    try {
      releaseOld = retainTestFeedbackOwner({ state: () => oldState, current: () => oldCurrent, parentRetired: () => false,
        plugin: { applyFeedback: oldApply, retireFeedback: oldRetire, addListener: async () => ({ remove: async () => undefined }) } });
      nativeFeedbackToast.noticeText("One is ready", { id: "successor-stable-notice", duration: Infinity, onDismiss });
      await waitFor(() => expect(oldApply).toHaveBeenCalledOnce());
      releaseNext = retainTestFeedbackOwner({ state: () => nextState, current: () => true, parentRetired: () => false,
        plugin: { applyFeedback: nextApply, retireFeedback: nextRetire, addListener: async () => ({ remove: async () => undefined }) } });
      oldCurrent = false;
      releaseOld(); releaseOld = () => undefined;
      await waitFor(() => expect(nextApply).toHaveBeenCalledOnce());
      expect(oldRetire).toHaveBeenCalledOnce();
      expect(nextApply.mock.calls[0][0].feedbackId).toBe("successor-stable-notice");
      const successorToast = toast.getToasts().find(value => value.title === "One is ready");
      expect(successorToast?.toasterId).toBe("native-owned-feedback");
      expect(successorToast?.id).not.toBe("successor-stable-notice");
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      expect(toast.getToasts().some(value => value.id === successorToast?.id)).toBe(true);
      expect(screen.queryByText("One is ready")).toBeNull();
      receiveNativeFeedbackEnd(feedbackEnd(nextApply.mock.calls[0][0], "user"));
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally { releaseOld(); releaseNext(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("fails closed when the old native child retirement is not confirmed", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "no-op-retirement-document", ownerEpoch: "no-op-retirement-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: false }));
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    let releaseOwner = () => undefined;
    try {
      releaseOwner = retainTestFeedbackOwner({ state: () => state, current: () => true, parentRetired: () => false,
        plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
      nativeFeedbackToast.noticeText("Keep this native while retirement is uncertain", { id: "no-op-retirement-notice", duration: Infinity });
      await waitFor(() => expect(applyFeedback).toHaveBeenCalledOnce());
      releaseOwner(); releaseOwner = () => undefined;
      await waitFor(() => expect(retireFeedback).toHaveBeenCalledOnce());
      expect(screen.queryByText("Keep this native while retirement is uncertain")).toBeNull();
      expect(toast.getToasts().some(value => value.id === "no-op-retirement-notice")).toBe(false);
    } finally { releaseOwner(); view.unmount(); privacy.state = initialPrivacy; }
  });

  it("keeps unrecognized opted-notice option keys on the full Sonner renderer", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "closed-shape-document", ownerEpoch: "closed-shape-owner", ownerGeneration: 1,
      revision: 1, family: "history", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "History", sections: [], open: true, enabled: true, backEnabled: true };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const owner = retainTestFeedbackOwner({ state: () => state, current: () => true, ready: () => true,
      plugin: { applyFeedback, retireFeedback, addListener: async () => ({ remove: async () => undefined }) } });
    const view = render(<><NativeFeedbackToaster /><Sonner /></>);
    try {
      nativeFeedbackToast.noticeText("Keep the authored notice", {
        id: "closed-shape-notice", unexpected: true,
      } as unknown as Parameters<typeof nativeFeedbackToast.noticeText>[1]);
      expect(await screen.findByText("Keep the authored notice")).toBeTruthy();
      expect(toast.getToasts().find(value => value.id === "closed-shape-notice")?.toasterId).toBeUndefined();
      expect(applyFeedback).not.toHaveBeenCalled();
      toast.dismiss("closed-shape-notice");
    } finally { owner(); view.unmount(); privacy.state = initialPrivacy; }
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { NativeDrawerProjection } from "@/lib/capacitor/native-drawers";
import { nativeFeedbackOptions, reconcileNativeFeedback, refreshNativeFeedback, receiveNativeFeedbackEnd, retainNativeFeedbackConsumer, retainNativeFeedbackOwner, retainNativeFeedbackForm, type NativeFeedbackProjection } from "@/lib/capacitor/native-feedback";
import { NativeFeedbackToaster } from "@/components/app-ui/native-feedback-toaster";
import { toast, Toaster as Sonner } from "sonner";
import { morphyToast } from "@/lib/morphy-ux/morphy";

const privacy = vi.hoisted(() => ({ state: { generation: 0, shielded: false, appIsActive: true, cause: "inactive" as const } }));
vi.mock("@/lib/capacitor/session-privacy", () => ({
  nativePrivacyCanInteract: (state = privacy.state) => state.appIsActive && !state.shielded,
  nativePrivacyObservation: () => ({ state: privacy.state, epoch: 0 }),
  subscribeNativePrivacyObservation: () => () => undefined,
}));
vi.mock("@/lib/capacitor/native-presentation-policy", () => ({ customNativePresentationEnabled: () => true }));

describe("private native feedback lifecycle", () => {
  it("keeps the actual Sonner promise on one native handle without a DOM duplicate", async () => {
    const initialPrivacy = { ...privacy.state };
    privacy.state = { ...privacy.state, generation: 0, shielded: false, appIsActive: true };
    const state: NativeDrawerProjection = { documentId: "feedback-document", ownerEpoch: "feedback-owner", ownerGeneration: 1,
      revision: 1, family: "profile", updateSequence: 1, privacyGeneration: 0, appearance: "light",
      accentHex: "#007aff", foregroundHex: "#111111", title: "Public settings", sections: [], open: true,
      enabled: true, backEnabled: true, profileDestinationId: "preferences-visit" };
    const applyFeedback = vi.fn(async (_state: NativeFeedbackProjection) => ({ applied: true }));
    const retireFeedback = vi.fn(async () => ({ retired: true }));
    const release = retainNativeFeedbackOwner({ state: () => state, current: () => true,
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
      const { message: _message, tone: _tone, duration: _duration, dismissible: _dismissible, ...end } = last;
      receiveNativeFeedbackEnd(end);
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
    const owner = retainNativeFeedbackOwner({ state: () => state, current: () => true, ready: () => admitted,
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
    const releaseOwner = retainNativeFeedbackOwner({ state: () => state, current: () => current,
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
      const end = ({ message: _message, tone: _tone, duration: _duration, dismissible: _dismissible, ...receipt }: NativeFeedbackProjection) => receipt;
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
    const owner = retainNativeFeedbackOwner({ state: () => state, current: () => true,
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
});

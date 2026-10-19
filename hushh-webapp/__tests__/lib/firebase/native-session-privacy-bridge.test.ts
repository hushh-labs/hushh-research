import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(), completeSessionValidation: vi.fn(), addListener: vi.fn(),
  getFeedbackCapabilities: vi.fn(), interactionFeedback: vi.fn(), platform: "ios",
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.platform !== "web", getPlatform: () => mocks.platform },
  registerPlugin: () => mocks,
}));
import {
  completeNativeSessionPrivacyValidation,
  getNativeSessionPrivacyState,
  subscribeNativeSessionPrivacy,
  nativePrivacyObservation,
  subscribeNativePrivacyObservation,
} from "@/lib/capacitor/session-privacy";
import { appHaptic, usesNativeHapticPreference } from "@/lib/capacitor/app-haptics";

const active = { shielded: true, generation: 3, cause: "background", appIsActive: true };

describe("native privacy bridge state validation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.platform = "ios"; });

  it("does not require native feedback or a secure-context UUID on web", () => {
    mocks.platform = "web";
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("UUID unavailable"); });
    try {
      expect(() => appHaptic("selection")).not.toThrow();
      expect(uuid).not.toHaveBeenCalled();
      expect(mocks.getFeedbackCapabilities).not.toHaveBeenCalled();
      expect(mocks.interactionFeedback).not.toHaveBeenCalled();
    } finally { uuid.mockRestore(); }
  });

  it.each([
    {}, { ...active, generation: 0 }, { ...active, cause: "unknown" },
    { ...active, appIsActive: undefined }, { ...active, generation: 1.5 },
  ])("does not treat malformed state as an absent cover: %j", async (state) => {
    mocks.getState.mockResolvedValue(state);
    await expect(getNativeSessionPrivacyState()).rejects.toThrow("unavailable");
  });

  it("preserves a refused active acknowledgement for reconciliation", async () => {
    mocks.completeSessionValidation.mockResolvedValue({ ...active, released: false });
    await expect(completeNativeSessionPrivacyValidation(2)).resolves.toEqual({ ...active, released: false });
    expect(mocks.completeSessionValidation).toHaveBeenCalledWith({ generation: 2, documentId: expect.any(String) });
  });

  it("requires an explicit completion result", async () => {
    mocks.completeSessionValidation.mockResolvedValue(active);
    await expect(completeNativeSessionPrivacyValidation(3)).rejects.toThrow("unavailable");
  });

  it("binds reads and acknowledgements to one document instance", async () => {
    mocks.getState.mockResolvedValue(active);
    mocks.completeSessionValidation.mockResolvedValue({ ...active, released: true });
    await getNativeSessionPrivacyState();
    await completeNativeSessionPrivacyValidation(3);
    const documentId = mocks.getState.mock.calls[0][0].documentId;
    expect(documentId).toEqual(expect.any(String));
    expect(mocks.completeSessionValidation).toHaveBeenCalledWith({ generation: 3, documentId });
  });

  it("subscribes to the distinct native event", async () => {
    const listener = vi.fn();
    mocks.addListener.mockResolvedValue({ remove: vi.fn() });
    await subscribeNativeSessionPrivacy(listener);
    const callback = mocks.addListener.mock.calls[0][1];
    callback({ ...active, action: "retry" });
    expect(listener).toHaveBeenCalledWith({ ...active, action: "retry" });
  });

  it("rejects feedback interrupted during capability discovery and cannot overwrite that lifecycle with an older read", async () => {
    const unshielded = { ...active, shielded: false, appIsActive: true };
    mocks.getState.mockResolvedValue(unshielded);
    await getNativeSessionPrivacyState();
    await subscribeNativeSessionPrivacy(vi.fn());
    let resolveCapability!: (value: { interactionFeedback: boolean }) => void;
    mocks.getFeedbackCapabilities.mockReturnValue(new Promise(resolve => { resolveCapability = resolve; }));
    appHaptic("selection", "interrupted");
    let resolveRead!: (value: typeof active) => void;
    mocks.getState.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    const oldRead = getNativeSessionPrivacyState();
    const interrupted = { ...active, generation: 4, action: "state" };
    mocks.addListener.mock.calls.at(-1)![1](interrupted);
    resolveRead(unshielded);
    await oldRead;
    expect(nativePrivacyObservation().state).toEqual(interrupted);
    resolveCapability({ interactionFeedback: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.interactionFeedback).not.toHaveBeenCalled();
  });

  it.each(["ios", "android"])("uses one accepted Settings feedback transport on %s and never retries an uncertain result", async platform => {
    mocks.platform = platform;
    mocks.getState.mockResolvedValue({ ...active, shielded: false });
    await getNativeSessionPrivacyState();
    mocks.interactionFeedback.mockRejectedValue(new Error("UNCERTAIN"));
    appHaptic("selection", "accepted-choice");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(usesNativeHapticPreference()).toBe(true);
    expect(mocks.interactionFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.interactionFeedback).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expect.any(String), privacyGeneration: 3, intentId: "accepted-choice", kind: "selection",
    }));
  });

  it.each(["ios", "android"])("admits a new %s interaction after confirmed release without a native event, fencing earlier reads", async platform => {
    mocks.platform = platform;
    mocks.getState.mockResolvedValue(active);
    await getNativeSessionPrivacyState();
    let resolveRead!: (value: typeof active) => void;
    mocks.getState.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    const earlierRead = getNativeSessionPrivacyState();
    const observation = vi.fn();
    const unsubscribe = subscribeNativePrivacyObservation(observation);
    const released = { ...active, shielded: false, released: true };
    mocks.completeSessionValidation.mockResolvedValue(released);
    await completeNativeSessionPrivacyValidation(active.generation);
    resolveRead(active);
    await earlierRead;
    expect(nativePrivacyObservation().state).toEqual(released);
    expect(observation).toHaveBeenCalledOnce();
    unsubscribe();

    mocks.getState.mockResolvedValue(released);
    mocks.interactionFeedback.mockResolvedValue({ accepted: true });
    appHaptic("selection", "post-release-choice");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.interactionFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.interactionFeedback).toHaveBeenCalledWith(expect.objectContaining({
      privacyGeneration: active.generation, intentId: "post-release-choice",
    }));
  });

  it("does not let a delayed release replace a newer inactive lifecycle observation", async () => {
    mocks.getState.mockResolvedValue(active);
    await getNativeSessionPrivacyState();
    await subscribeNativeSessionPrivacy(vi.fn());
    let resolveCompletion!: (value: typeof active & { released: boolean }) => void;
    mocks.completeSessionValidation.mockReturnValueOnce(new Promise(resolve => { resolveCompletion = resolve; }));
    const pendingRelease = completeNativeSessionPrivacyValidation(active.generation);
    const interrupted = { ...active, generation: 4, appIsActive: false, action: "state" };
    mocks.addListener.mock.calls.at(-1)![1](interrupted);
    resolveCompletion({ ...active, shielded: false, released: true });
    await pendingRelease;
    expect(nativePrivacyObservation().state).toEqual(interrupted);
    appHaptic("selection", "covered-choice");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.interactionFeedback).not.toHaveBeenCalled();
  });

  it("does not lose confirmed release when another consumer receives the same lifecycle event", async () => {
    mocks.getState.mockResolvedValue(active);
    await getNativeSessionPrivacyState();
    await subscribeNativeSessionPrivacy(vi.fn());
    await subscribeNativeSessionPrivacy(vi.fn());
    let resolveCompletion!: (value: typeof active & { released: boolean }) => void;
    mocks.completeSessionValidation.mockReturnValueOnce(new Promise(resolve => { resolveCompletion = resolve; }));
    const pendingRelease = completeNativeSessionPrivacyValidation(active.generation);
    // Each component registers a Capacitor listener. A duplicate delivery is
    // not a new inactive cycle and must not discard the sole release receipt.
    mocks.addListener.mock.calls.at(-1)![1]({ ...active, action: "state" });
    const released = { ...active, shielded: false, released: true };
    resolveCompletion(released);
    await pendingRelease;
    expect(nativePrivacyObservation().state).toEqual(released);
  });

  it("returns the current lifecycle to a reader superseded by an inactive event", async () => {
    mocks.getState.mockResolvedValue({ ...active, shielded: false });
    await getNativeSessionPrivacyState();
    await subscribeNativeSessionPrivacy(vi.fn());
    let resolveRead!: (value: typeof active) => void;
    mocks.getState.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    const oldRead = getNativeSessionPrivacyState();
    const interrupted = { ...active, generation: 4, appIsActive: false, action: "state" };
    mocks.addListener.mock.calls.at(-1)![1](interrupted);
    resolveRead({ ...active, shielded: false });
    expect(await oldRead).toEqual(interrupted);
    expect(nativePrivacyObservation().state).toEqual(interrupted);
  });
});

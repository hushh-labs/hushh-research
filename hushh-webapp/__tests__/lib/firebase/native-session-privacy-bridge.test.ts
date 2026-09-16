import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getState: vi.fn(), completeSessionValidation: vi.fn(), addListener: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => mocks,
}));
import {
  completeNativeSessionPrivacyValidation,
  getNativeSessionPrivacyState,
  subscribeNativeSessionPrivacy,
} from "@/lib/capacitor/session-privacy";

const active = { shielded: true, generation: 3, cause: "background", appIsActive: true };

describe("native privacy bridge state validation", () => {
  beforeEach(() => vi.clearAllMocks());

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
});

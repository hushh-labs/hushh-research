import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
const native = vi.hoisted(() => ({ recognize: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined), available: true }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios", isPluginAvailable: () => native.available }, registerPlugin: () => ({ recognize: native.recognize, cancel: native.cancel }) }));
vi.mock("@/lib/wallet/card-scan-image", () => ({ validateCardImage: vi.fn().mockResolvedValue(undefined) }));
import { scanWalletCard, scanWalletCardForReview } from "@/lib/services/wallet-card-scan";
const photo = () => ({ type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Blob;
beforeEach(() => { native.available = true; native.recognize.mockReset(); native.cancel.mockClear(); });
afterEach(() => vi.useRealTimers());
it("preserves Vision fields without artwork if the secondary browser decoder fails", async () => {
  native.recognize.mockResolvedValue({ cardText: "4242424242424242\nEXPIRY 12/30" });
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("Synthetic decoder failure")));
  try { expect(await scanWalletCardForReview(photo(), new AbortController().signal, { artwork: true })).toMatchObject({ fields: { pan: "4242424242424242", expiry: "12/30" } }); }
  finally { vi.unstubAllGlobals(); }
});
it("uses the permitted native projection", async () => {
  native.recognize.mockResolvedValue({ cardText: "4242 4242 4242 4242\n12/30" });
  expect(await scanWalletCard(photo(), new AbortController().signal)).toEqual({ pan: "4242424242424242", expiry: "12/30" });
  expect(native.recognize).toHaveBeenCalledWith({ image: "AQID", requestId: expect.any(String) }); expect(native.cancel).toHaveBeenCalledOnce();
});
it("preserves native expiry and name without a PAN", async () => {
  native.recognize.mockResolvedValue({ cardText: "EXPIRY 12/30\nALEX SAMPLE" });
  expect(await scanWalletCard(photo(), new AbortController().signal)).toEqual({ expiry: "12/30", cardholderName: "ALEX SAMPLE" });
});
it("instructs a missing-plugin binary to update", async () => { native.available = false; await expect(scanWalletCard(photo(), new AbortController().signal)).rejects.toThrow("Update the app"); expect(native.recognize).not.toHaveBeenCalled(); });
it.each(["cancel", "epoch"])("cancels native recognition after %s", async mode => {
  const controller = new AbortController(); native.recognize.mockImplementation(() => new Promise(() => {}));
  const pending = scanWalletCard(photo(), controller.signal), rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(native.recognize).toHaveBeenCalled()); if (mode === "cancel") controller.abort(); else advanceVaultSessionEpoch();
  await rejection; expect(native.cancel).toHaveBeenCalledWith({ requestId: expect.any(String) });
});
it("bounds a stalled native scan", async () => {
  vi.useFakeTimers(); native.recognize.mockImplementation(() => new Promise(() => {})); const pending = scanWalletCard(photo(), new AbortController().signal), rejection = expect(pending).rejects.toThrow("too long"); await vi.advanceTimersByTimeAsync(30001); await rejection;
});

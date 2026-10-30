import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { FULL_CARD } from "@/lib/wallet/card-scan-image";
import { parseCardScanReading } from "@/lib/wallet/card-scan-fields";
const native = vi.hoisted(() => ({ recognize: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined), available: true }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios", isPluginAvailable: () => native.available }, registerPlugin: () => ({ recognize: native.recognize, cancel: native.cancel }) }));
vi.mock("@/lib/wallet/card-scan-image", async original => ({ ...await original<typeof import("@/lib/wallet/card-scan-image")>(), validateCardImage: vi.fn().mockResolvedValue(undefined) }));
import { scanWalletCard, scanWalletCardForReview } from "@/lib/services/wallet-card-scan";
const photo = () => ({ type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Blob;
class LocalWorker {
  static last: LocalWorker | null = null;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { LocalWorker.last = this; }
}
beforeEach(() => {
  native.available = true; native.recognize.mockReset(); native.cancel.mockClear(); LocalWorker.last = null;
  vi.stubGlobal("Worker", LocalWorker);
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(16) }) } as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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
it("reads a full-photo crop with Vision even when browser decoding is unavailable", async () => {
  native.recognize.mockResolvedValue({ cardText: "4242424242424242\nEXPIRY 12/30\nALEX SAMPLE" });
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("Synthetic decoder failure")));
  expect(await scanWalletCardForReview(photo(), new AbortController().signal, { corners: FULL_CARD })).toMatchObject({ fields: { pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" } });
  expect(LocalWorker.last).toBeNull();
});
it.each(["missing", "failed"])("falls back to bundled local OCR when native recognition is %s", async mode => {
  native.available = mode !== "missing"; native.recognize.mockRejectedValue(new Error("Synthetic Vision failure"));
  const pending = scanWalletCardForReview(photo(), new AbortController().signal, { corners: FULL_CARD });
  await vi.waitFor(() => expect(LocalWorker.last).not.toBeNull());
  const worker = LocalWorker.last!;
  worker.onmessage?.({ data: { reading: parseCardScanReading("4242424242424242\n12/30\nALEX SAMPLE") } });
  expect(await pending).toMatchObject({ fields: { pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" } });
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(native.recognize).toHaveBeenCalledTimes(mode === "missing" ? 0 : 1);
});
it.each(["cancel", "epoch"])("cancels native recognition after %s", async mode => {
  const controller = new AbortController(); native.recognize.mockImplementation(() => new Promise(() => {}));
  const pending = scanWalletCard(photo(), controller.signal), rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(native.recognize).toHaveBeenCalled()); if (mode === "cancel") controller.abort(); else advanceVaultSessionEpoch();
  await rejection; expect(native.cancel).toHaveBeenCalledWith({ requestId: expect.any(String) });
});
it("bounds a stalled native scan and continues with cancellable local OCR", async () => {
  vi.useFakeTimers(); native.recognize.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController(), pending = scanWalletCard(photo(), controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(30001);
  expect(LocalWorker.last).not.toBeNull(); expect(native.cancel).toHaveBeenCalledOnce();
  controller.abort(); await rejection; expect(LocalWorker.last!.terminate).toHaveBeenCalledOnce();
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ recognize: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined), available: true }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "ios", isPluginAvailable: () => native.available }, registerPlugin: () => ({ recognize: native.recognize, cancel: native.cancel }) }));
import { scanWalletCard } from "@/lib/services/wallet-card-scan";
const photo = () => ({ type: "image/jpeg", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as Blob;
beforeEach(() => { native.available = true; native.recognize.mockReset(); });
afterEach(() => vi.useRealTimers());
it("uses native OCR and parses its result", async () => {
 native.recognize.mockResolvedValue({ text: "4242 4242 4242 4242\n12/30" });
 expect(await scanWalletCard(photo(), new AbortController().signal)).toEqual({ pan: "4242424242424242", expiry: "12/30" });
 expect(native.recognize).toHaveBeenCalledWith({ image: "AQID", requestId: expect.any(String) });
});
it("gives an update instruction when the installed binary lacks the plugin", async () => {
 native.available = false;
 await expect(scanWalletCard(photo(), new AbortController().signal)).rejects.toThrow("Update the app");
 expect(native.recognize).not.toHaveBeenCalled();
});
it("does not return a result after cancellation", async () => {
 const controller = new AbortController();
 native.recognize.mockImplementation(() => new Promise(() => {}));
 const pending = scanWalletCard(photo(), controller.signal);
 await Promise.resolve(); controller.abort();
 await expect(pending).rejects.toMatchObject({ name: "AbortError" });
 expect(native.cancel).toHaveBeenCalledWith({ requestId: expect.any(String) });
});
it("bounds a stalled native scan", async () => {
 vi.useFakeTimers(); native.recognize.mockImplementation(() => new Promise(() => {}));
 const pending = scanWalletCard(photo(), new AbortController().signal);
 const rejected = expect(pending).rejects.toThrow("too long");
 await vi.advanceTimersByTimeAsync(30000); await rejected;
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanWalletCard, scanWalletCardForReview } from "@/lib/services/wallet-card-scan";
import { parseCardScanReading } from "@/lib/wallet/card-scan-fields";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";

vi.mock("@/lib/wallet/card-scan-image", async original => ({ ...await original<typeof import("@/lib/wallet/card-scan-image")>(), validateCardImage: async (blob: Blob) => { if (blob.type !== "image/png") throw new Error("Unsupported image"); } }));
class ScanWorker {
  static last: ScanWorker | null;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { ScanWorker.last = this; }
}
const photo = () => new Blob(["owned synthetic"], { type: "image/png" });
async function started() { await vi.waitFor(() => expect(ScanWorker.last).not.toBeNull()); return ScanWorker.last!; }
describe("owned local scan supervisor", () => {
  beforeEach(() => {
    ScanWorker.last = null; vi.stubGlobal("Worker", ScanWorker);
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 2, height: 2, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(16) }) } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("accepts only the structured permitted projection and terminates its worker", async () => {
    const pending = scanWalletCard(photo(), new AbortController().signal), worker = await started();
    worker.onmessage?.({ data: { reading: parseCardScanReading("4242 4242 4242 4242") } });
    expect(await pending).toEqual({ pan: "4242424242424242" }); expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.postMessage.mock.calls[0][0]).toHaveProperty("pixels"); expect(worker.postMessage.mock.calls[0][0]).not.toHaveProperty("text");
  });
  it("returns independent fields when the card number is missing", async () => {
    const pending = scanWalletCardForReview(photo(), new AbortController().signal), worker = await started();
    worker.onmessage?.({ data: { reading: parseCardScanReading("VALID THRU 12/30\nALEX SAMPLE") } });
    expect(await pending).toMatchObject({ fields: { expiry: "12/30", cardholderName: "ALEX SAMPLE" }, states: { pan: "missing" } });
  });
  it("rejects an old raw-text message instead of exposing a transcript", async () => {
    const pending = scanWalletCard(photo(), new AbortController().signal); const rejection = expect(pending).rejects.toThrow("unavailable");
    const worker = await started(); worker.onmessage?.({ data: { text: "short secret code" } }); await rejection; expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects unsupported files before acquiring a worker", async () => {
    await expect(scanWalletCard(new Blob(["text"], { type: "text/plain" }), new AbortController().signal)).rejects.toThrow(); expect(ScanWorker.last).toBeNull();
  });
  it.each(["cancel", "epoch"])("settles and terminates when %s changes", async mode => {
    const controller = new AbortController(), pending = scanWalletCard(photo(), controller.signal), rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const worker = await started(); if (mode === "cancel") controller.abort(); else advanceVaultSessionEpoch(); await rejection; expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("bounds stalled initialization", async () => {
    vi.useFakeTimers(); const pending = scanWalletCard(photo(), new AbortController().signal), rejection = expect(pending).rejects.toThrow("unavailable");
    await vi.advanceTimersByTimeAsync(100); const worker = ScanWorker.last!; expect(worker).not.toBeNull(); await vi.advanceTimersByTimeAsync(90000); await rejection; expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("retains a useful local reading when a later OCR pass exceeds the deadline", async () => {
    vi.useFakeTimers();
    const pending = scanWalletCardForReview(photo(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    const worker = ScanWorker.last!;
    worker.onmessage?.({ data: { reading: parseCardScanReading("4242424242424242\n12/30\nALEX SAMPLE"), progress: true } });
    await vi.advanceTimersByTimeAsync(90000);
    expect(await pending).toMatchObject({ fields: { pan: "4242424242424242", expiry: "12/30", cardholderName: "ALEX SAMPLE" } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("discards partial OCR on vault lock instead of using deadline recovery", async () => {
    const pending = scanWalletCardForReview(photo(), new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const worker = await started();
    worker.onmessage?.({ data: { reading: parseCardScanReading("4242424242424242"), progress: true } });
    advanceVaultSessionEpoch(); await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

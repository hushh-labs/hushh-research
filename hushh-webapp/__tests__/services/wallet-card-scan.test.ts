import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanWalletCard } from "@/lib/services/wallet-card-scan";
class ScanWorker {
  static last: ScanWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { ScanWorker.last = this; }
}
const photo = () => new Blob(["synthetic"], { type: "image/png" });
describe("owned local card OCR", () => {
  beforeEach(() => { vi.stubGlobal("Worker", ScanWorker); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("returns validated details and releases the worker", async () => {
    const result = scanWalletCard(photo(), new AbortController().signal);
    ScanWorker.last.onmessage?.({ data: { text: "4242 4242 4242 4242" } });
    expect(await result).toEqual({ pan: "4242424242424242" });
    expect(ScanWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("rejects unsupported images before starting OCR", async () => {
    await expect(scanWalletCard(new Blob(["text"], { type: "text/plain" }), new AbortController().signal)).rejects.toThrow();
  });
  it("releases the owned worker when initialization reports failure", async () => {
    const result = scanWalletCard(photo(), new AbortController().signal);
    ScanWorker.last.onmessage?.({ data: { error: "scan_failed" } });
    await expect(result).rejects.toThrow("Card scan unavailable");
    expect(ScanWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("cancels before initialization completes", async () => {
    const controller = new AbortController();
    const result = scanWalletCard(photo(), controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(ScanWorker.last.terminate).toHaveBeenCalledOnce();
  });
  it("bounds stalled initialization", async () => {
    vi.useFakeTimers();
    const result = scanWalletCard(photo(), new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("Card scan unavailable");
    await vi.advanceTimersByTimeAsync(60000); await rejected;
    expect(ScanWorker.last.terminate).toHaveBeenCalledOnce();
  });
});

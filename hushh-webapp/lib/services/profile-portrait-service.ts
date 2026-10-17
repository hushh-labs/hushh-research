import { validateCardImage } from "@/lib/wallet/card-scan-image";
import { normalizeToAvatarDataUrl } from "@/lib/profile/avatar-capture";
import { admittedPortraitSource } from "@/lib/profile/provider-avatar";
import { isNative } from "@/lib/capacitor/platform";

const MAX_BYTES = 512 * 1024;

/** Bounded, cancellable media preparation. Remote sources are admitted by the
 * authored provider gate; this is not an arbitrary URL or authenticated API. */
export async function prepareProfilePortrait(source: string, signal: AbortSignal): Promise<string> {
  if (!admittedPortraitSource(source)) throw new Error("PORTRAIT_UNAVAILABLE");
  // CapacitorHttp's GET proxy buffers an entire URLSession response before JS
  // sees its stream. Use the SDK-preserved WebKit fetch for this public media
  // read, so byte limits, AbortSignal and redirect policy apply during transfer.
  const webFetch = typeof window !== "undefined"
    ? (window as Window & { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch : undefined;
  if (isNative() && typeof webFetch !== "function") throw new Error("PORTRAIT_UNAVAILABLE");
  const download = webFetch ?? fetch;
  const timeout = new AbortController();
  const abort = () => timeout.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) timeout.abort();
  const timer = setTimeout(abort, 8_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await download.call(globalThis, source, { signal: timeout.signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("PORTRAIT_UNAVAILABLE");
    reader = response.body?.getReader();
    if (!reader) throw new Error("PORTRAIT_UNAVAILABLE");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let count = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > MAX_BYTES) throw new Error("PORTRAIT_UNAVAILABLE");
      chunks.push(new Uint8Array(next.value));
    }
    const blob = new Blob(chunks, { type: response.headers.get("content-type")?.split(";")[0] });
    // Reuse the existing raster-header validator; compressed size alone cannot
    // prevent a decoding bomb. The small portrait budget precedes Image decode.
    await validateCardImage(blob, { maxBytes: MAX_BYTES, maxDimension: 2048, maxPixels: 4_194_304 });
    if (timeout.signal.aborted) throw new Error("PORTRAIT_UNAVAILABLE");
    const data = await new Promise<string>((resolve, reject) => {
      const file = new FileReader();
      const cancel = () => file.abort();
      const finish = () => timeout.signal.removeEventListener("abort", cancel);
      file.onload = () => { finish(); typeof file.result === "string" ? resolve(file.result) : reject(new Error("PORTRAIT_UNAVAILABLE")); };
      file.onerror = file.onabort = () => { finish(); reject(new Error("PORTRAIT_UNAVAILABLE")); };
      timeout.signal.addEventListener("abort", cancel, { once: true });
      if (timeout.signal.aborted) { finish(); reject(new Error("PORTRAIT_UNAVAILABLE")); return; }
      file.readAsDataURL(blob);
    });
    return await normalizeToAvatarDataUrl(data, timeout.signal);
  } finally {
    clearTimeout(timer); signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

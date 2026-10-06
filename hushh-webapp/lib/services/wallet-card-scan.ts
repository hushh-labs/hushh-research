import type { ScannedCardFields } from "@/lib/wallet/card-scan-fields";
import { parseCardScan } from "@/lib/wallet/card-scan-fields";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** The owned supervisor bounds initialization, recognition and nested worker lifetime. */
export async function scanWalletCard(file: Blob, signal: AbortSignal): Promise<ScannedCardFields> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > MAX_IMAGE_BYTES) {
    throw new Error("Choose a JPG, PNG or WebP photo smaller than 15 MB.");
  }
  signal.throwIfAborted();
  const worker = new Worker(new URL("/wallet/card-scan-worker.js", window.location.href));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise<ScannedCardFields>((resolve, reject) => {
      const fail = () => reject(new Error("Card scan unavailable. Enter the details manually."));
      abort = () => reject(new DOMException("Scan cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data;
        if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") { fail(); return; }
        const fields = parseCardScan(value.text);
        if (fields) resolve(fields); else fail();
      };
      timeout = setTimeout(fail, 60_000);
      worker.postMessage(file);
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}

/** Native acquisition returns memory-only bytes; the plugin does not save to Gallery. */
export async function pickNativeWalletCard(source: "camera" | "photos"): Promise<Blob | null> {
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  const { isCameraCancellation } = await import("@/lib/profile/avatar-capture");
  try {
    const photo = await Camera.getPhoto({
      source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.DataUrl, allowEditing: false, quality: 95,
      width: 2400, height: 2400, correctOrientation: true, saveToGallery: false,
    });
    if (!photo.dataUrl) throw new Error("No photo selected");
    const [header, content] = photo.dataUrl.split(",");
    if (!content) throw new Error("No photo selected");
    const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: header?.match(/^data:([^;]+)/)?.[1] ?? "image/jpeg" });
  } catch (error) {
    if (isCameraCancellation(error)) return null;
    throw new Error("Camera unavailable");
  }
}

import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { registerInspectedWalletPhoto } from "@/lib/wallet/card-artwork";
import { Capacitor } from "@capacitor/core";
import { nativeCardScanner, nativeCardCapture } from "@/lib/capacitor/card-scanner";
import { mergeCardScanReadings, parseCardScanReading, type CardScanReading, type ScannedCardFields } from "@/lib/wallet/card-scan-fields";
import type { CardRaster } from "@/lib/wallet/card-scan-raster";
import { walletOperationId } from "@/lib/wallet/wallet-operation-id";
import { isFullCard, validCardCorners, validateCardImage, type CardCorners, type CardImageBox } from "@/lib/wallet/card-scan-image";

export class CardScanError extends Error {}
export interface CardScanDraft extends CardScanReading { sanitized?: Blob; candidate?: Blob }

function assertScanCurrent(signal: AbortSignal, epoch: number, owner: ReturnType<typeof snapshotValidatedAuthSessionOwner>): void {
  signal.throwIfAborted();
  if (!isVaultSessionEpochCurrent(epoch) || (owner && !isValidatedAuthSessionOwnerCurrent(owner))) throw new DOMException("Scan cancelled", "AbortError");
}

async function decodeCardPhoto(file: Blob, signal: AbortSignal): Promise<CardRaster> {
  let release = () => {};
  const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(file, { imageOrientation: "from-image" }) : await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(), url = URL.createObjectURL(file);
    const abort = () => { image.src = ""; URL.revokeObjectURL(url); reject(new DOMException("Scan cancelled", "AbortError")); };
    release = () => { signal.removeEventListener("abort", abort); URL.revokeObjectURL(url); image.src = ""; };
    signal.addEventListener("abort", abort, { once: true });
    image.onload = () => resolve(image); image.onerror = () => { release(); reject(new Error("Photo unavailable.")); };
    if (signal.aborted) abort(); else image.src = url;
  });
  const canvas = document.createElement("canvas");
  try {
    signal.throwIfAborted();
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image decoding unavailable.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    signal.throwIfAborted(); return { width: canvas.width, height: canvas.height, data: image.data };
  } finally { if ("close" in bitmap) bitmap.close(); release(); canvas.width = canvas.height = 0; }
}

async function prepareCardLocally(file: Blob, signal: AbortSignal, options: { corners?: CardCorners; detectOnly?: boolean; prepareOnly?: boolean }): Promise<{ corners?: CardCorners; detected?: boolean; prepared?: Blob }> {
  const epoch = snapshotVaultSessionEpoch(), owner = snapshotValidatedAuthSessionOwner();
  await validateCardImage(file); assertScanCurrent(signal, epoch, owner);
  const pixels = await decodeCardPhoto(file, signal); assertScanCurrent(signal, epoch, owner);
  const worker = new Worker(new URL("/wallet/card-scan-worker.js", window.location.href));
  let timer: ReturnType<typeof setTimeout> | undefined, abort = () => {}, releaseEpoch = () => {};
  try { return await new Promise((resolve, reject) => {
    abort = () => reject(new DOMException("Scan cancelled", "AbortError")); signal.addEventListener("abort", abort, { once: true });
    releaseEpoch = subscribeVaultSessionEpoch(() => { if (!isVaultSessionEpochCurrent(epoch)) abort(); });
    assertScanCurrent(signal, epoch, owner);
    worker.onerror = () => reject(new Error("Crop unavailable."));
    worker.onmessage = event => { try { assertScanCurrent(signal, epoch, owner); event.data?.error ? reject(new Error("Crop unavailable.")) : resolve(event.data); } catch (error) { reject(error); } };
    timer = setTimeout(() => reject(new Error("Crop unavailable.")), 10_000);
    worker.postMessage({ pixels, ...options }, [pixels.data.buffer]);
  }); } finally { releaseEpoch(); worker.terminate(); clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export async function detectWalletCardRegion(file: Blob, signal: AbortSignal): Promise<{ corners?: CardCorners; detected?: boolean }> {
  return prepareCardLocally(file, signal, { detectOnly: true });
}

/** The supervisor owns all image/worker lifetime; no raw OCR text crosses it. */
export async function scanWalletCardForReview(file: Blob, signal: AbortSignal, options: { corners?: CardCorners; artwork?: boolean; sanitizeOnly?: boolean; masks?: CardImageBox[] } = {}): Promise<CardScanDraft> {
  const deadline = Date.now() + 90_000;
  const epoch = snapshotVaultSessionEpoch(), owner = snapshotValidatedAuthSessionOwner();
  await validateCardImage(file).catch(error => { throw new CardScanError(error.message); });
  assertScanCurrent(signal, epoch, owner);
  if (options.corners && !validCardCorners(options.corners)) throw new CardScanError("Card crop unavailable.");
  let nativeReading: CardScanReading | undefined;
  if (Capacitor.getPlatform() === "ios" && !options.sanitizeOnly && Capacitor.isPluginAvailable("HushhCardScanner")) {
    const requestId = walletOperationId();
    let timer: ReturnType<typeof setTimeout> | undefined, abort = () => {}, releaseEpoch = () => {};
    try {
      // Full-photo selection needs no browser crop before on-device Vision.
      // A selected quadrilateral must still be applied before recognition.
      const cropped = options.corners && !isFullCard(options.corners);
      const prepared = cropped ? (await prepareCardLocally(file, signal, { corners: options.corners, prepareOnly: true })).prepared : file;
      if (!prepared) throw new CardScanError("Card crop unavailable.");
      const bytes = new Uint8Array(await prepared.arrayBuffer());
      assertScanCurrent(signal, epoch, owner);
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      const result = await Promise.race([
        nativeCardScanner.recognize({ image: btoa(binary), requestId }),
        new Promise<never>((_, reject) => {
          abort = () => reject(new DOMException("Scan cancelled", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });
          releaseEpoch = subscribeVaultSessionEpoch(() => { if (!isVaultSessionEpochCurrent(epoch)) abort(); });
          assertScanCurrent(signal, epoch, owner);
          timer = setTimeout(() => reject(new CardScanError("Scanning took too long. Try another photo.")), 30_000);
        }),
      ]);
      assertScanCurrent(signal, epoch, owner);
      nativeReading = parseCardScanReading(result.cardText);
      if (!options.artwork && (!options.corners || (nativeReading.states.pan === "recognized" && nativeReading.fields.expiry && nativeReading.fields.cardholderName))) return nativeReading;
    } catch (error) {
      assertScanCurrent(signal, epoch, owner);
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Native OCR is an optimization. Its failure can retry the same local,
      // owner-bound pixels through the bundled browser recognizer.
    } finally {
      void nativeCardScanner.cancel({ requestId }).catch(() => {});
      releaseEpoch(); clearTimeout(timer); signal.removeEventListener("abort", abort);
    }
  }
  try {
  const pixels = await decodeCardPhoto(file, signal);
  assertScanCurrent(signal, epoch, owner);
  const worker = new Worker(new URL("/wallet/card-scan-worker.js", window.location.href));
  let timer: ReturnType<typeof setTimeout> | undefined, abort = () => {}, releaseEpoch = () => {};
  let partial: CardScanReading | undefined;
  try {
    return await new Promise<CardScanDraft>((resolve, reject) => {
      const fail = () => {
        try { assertScanCurrent(signal, epoch, owner); } catch (error) { reject(error); return; }
        if (partial && Object.keys(partial.fields).length && !options.artwork && !options.sanitizeOnly) {
          resolve(nativeReading ? mergeCardScanReadings([nativeReading, partial]) : partial);
        } else reject(new CardScanError("Card scanning is unavailable. Enter your details or try again."));
      };
      abort = () => reject(new DOMException("Scan cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
          releaseEpoch = subscribeVaultSessionEpoch(() => { if (!isVaultSessionEpochCurrent(epoch)) abort(); });
          assertScanCurrent(signal, epoch, owner);
      if (signal.aborted) { abort(); return; }
      worker.onerror = fail; worker.onmessageerror = fail;
      worker.onmessage = event => {
        const value = event.data;
        if (!value?.reading?.fields || !value?.reading?.states || value.error) { fail(); return; }
        try { assertScanCurrent(signal, epoch, owner); } catch (error) { reject(error); return; }
        if (value.progress === true) { partial = value.reading; return; }
        if (value.sanitized instanceof Blob && owner) registerInspectedWalletPhoto(value.sanitized, owner.userId, epoch);
        resolve({ ...(nativeReading ? mergeCardScanReadings([nativeReading, value.reading]) : value.reading), ...(value.sanitized instanceof Blob ? { sanitized: value.sanitized } : {}), ...(value.candidate instanceof Blob ? { candidate: value.candidate } : {}) });
      };
      timer = setTimeout(fail, Math.max(1, deadline - Date.now()));
      worker.postMessage({ pixels, ...options }, [pixels.data.buffer]);
    });
  } finally { releaseEpoch(); clearTimeout(timer); signal.removeEventListener("abort", abort); worker.terminate(); }
  } catch (error) {
    assertScanCurrent(signal, epoch, owner);
    // Artwork is optional. A secondary worker failure cannot erase useful
    // Vision fields, and never grants approval to a partially processed photo.
    if (nativeReading && Object.keys(nativeReading.fields).length && !(error instanceof DOMException && error.name === "AbortError")) return nativeReading;
    throw error;
  }
}

/** Compatibility projection used by existing scan callers. */
export async function scanWalletCard(file: Blob, signal: AbortSignal): Promise<ScannedCardFields> {
  const result = await scanWalletCardForReview(file, signal);
  if (!Object.keys(result.fields).length) throw new CardScanError("No readable card details found. Retake the photo or enter the details manually.");
  return result.fields;
}

/** Native conversion and acquisition; gallery saving is disabled. Android's
 * camera may use a transient file managed by Capacitor, not Wallet storage. */
export async function pickNativeWalletCard(source: "camera" | "photos", signal?: AbortSignal): Promise<Blob | null> {
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  const { isCameraCancellation } = await import("@/lib/profile/avatar-capture");
  const androidCapture = source === "camera" && Capacitor.getPlatform() === "android", requestId = walletOperationId();
  let timer: ReturnType<typeof setTimeout> | undefined, abort = () => {};
  try {
    signal?.throwIfAborted();
    const acquisition = androidCapture ? nativeCardCapture.takePhoto({ requestId }) : Camera.getPhoto({ source: source === "camera" ? CameraSource.Camera : CameraSource.Photos,
      resultType: CameraResultType.DataUrl, allowEditing: false, quality: 90, width: 2400, height: 2400,
      correctOrientation: true, saveToGallery: false });
    const photo = await Promise.race([acquisition, new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException("Capture cancelled", "AbortError")); signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, 180_000);
    })]);
    signal?.throwIfAborted();
    if ("cancelled" in photo && photo.cancelled) return null;
    if (!photo.dataUrl) throw new Error("No photo selected");
    const [header, content] = photo.dataUrl.split(",");
    if (!content) throw new Error("No photo selected");
    const bytes = Uint8Array.from(atob(content), character => character.charCodeAt(0));
    return new Blob([bytes], { type: header?.match(/^data:([^;]+)/)?.[1] ?? "image/jpeg" });
  } catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; if (isCameraCancellation(error)) return null; throw new Error("Camera unavailable"); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (androidCapture) void nativeCardCapture.cancel({ requestId }).catch(() => {}); }
}

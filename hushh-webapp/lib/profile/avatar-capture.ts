"use client";

import { isNative } from "@/lib/capacitor/platform";

// Avatars render tiny; a 256px square JPEG keeps the stored data-URL ~20-30 KB
// so it lives comfortably in the DB identity row and ships in identity payloads.
const AVATAR_SIZE = 256;
const JPEG_QUALITY = 0.82;

/**
 * Pick a profile photo — native camera/library on iOS (@capacitor/camera with
 * the native square-crop editor), or a file picker on web — then center-crop +
 * downscale to a small square JPEG data-URL. Resolves null if the user cancels.
 */
export async function pickAvatarDataUrl(): Promise<string | null> {
  const raw = await pickRawImage();
  if (!raw) return null;
  return normalizeToAvatarDataUrl(raw);
}

async function pickRawImage(): Promise<string | null> {
  if (isNative()) {
    try {
      const { Camera, CameraResultType, CameraSource } = await import(
        "@capacitor/camera"
      );
      const photo = await Camera.getPhoto({
        source: CameraSource.Prompt, // native "Take Photo / Choose from Library"
        resultType: CameraResultType.DataUrl,
        allowEditing: true, // native square crop
        quality: 85,
        width: 512,
        height: 512,
        correctOrientation: true,
        promptLabelHeader: "Profile photo",
        promptLabelPhoto: "Choose from Library",
        promptLabelPicture: "Take Photo",
      });
      return photo.dataUrl ?? null;
    } catch {
      // Cancel or plugin error → treat as no-op.
      return null;
    }
  }
  return pickImageViaFileInput();
}

// Web fallback: a transient hidden <input type="file"> → data-URL.
function pickImageViaFileInput(): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;";
    let settled = false;
    let cancelTimer: number | undefined;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      if (cancelTimer !== undefined) window.clearTimeout(cancelTimer);
      input.remove();
      resolve(value);
    };
    input.onchange = () => {
      // A file was chosen — disarm the focus-based cancel detection so a slow
      // FileReader (large image on a slow device) can't lose the race to the
      // 600ms grace timer and silently drop the user's photo.
      window.removeEventListener("focus", onFocus);
      if (cancelTimer !== undefined) {
        window.clearTimeout(cancelTimer);
        cancelTimer = undefined;
      }
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () =>
        done(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => done(null);
      reader.readAsDataURL(file);
    };
    // No reliable "cancel" event for a file dialog; when the window regains
    // focus without an onchange, resolve null after a short grace period.
    const onFocus = () => {
      cancelTimer = window.setTimeout(() => done(null), 600);
    };
    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Center-crop to a square, downscale to AVATAR_SIZE, re-encode as a JPEG
 * data-URL. Enforces the small-payload contract for both native and web images.
 */
export function normalizeToAvatarDataUrl(sourceDataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Image processing is not available."));
      return;
    }
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight) || AVATAR_SIZE;
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = AVATAR_SIZE;
      canvas.height = AVATAR_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not process the image."));
        return;
      }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
      try {
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Could not encode the image."));
      }
    };
    img.onerror = () => reject(new Error("Could not load the selected image."));
    img.src = sourceDataUrl;
  });
}

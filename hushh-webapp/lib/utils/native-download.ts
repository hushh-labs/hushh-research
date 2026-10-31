import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";

/**
 * Cross-platform file download utility
 *
 * Platform behavior:
 * - Native: writes the file, then hands it to the system share sheet so the
 *   person actively chooses where it goes (Files, AirDrop, mail to themselves).
 * - Web: standard browser download.
 *
 * Why the share sheet rather than a toast pointing at the Files app: the app's
 * Documents directory is only visible to a person when Info.plist sets BOTH
 * UIFileSharingEnabled and LSSupportsOpeningDocumentsInPlace. Both are false
 * here, deliberately, so writing to Documents and announcing "Saved to Files
 * app" told people their file was somewhere they could reach when it was not.
 * For a vault recovery key that is the worst possible lie: the key cannot be
 * regenerated, and someone who believes it is saved will dismiss the only
 * dialog that could still show it to them.
 *
 * Success is therefore only claimed once the share sheet has actually accepted
 * the file. A cancel is reported as not saved, because it is.
 */
export async function downloadTextFile(
  content: string,
  filename: string,
  isEffectCurrent: () => boolean = () => true,
): Promise<boolean> {
  return downloadFileBlob(new Blob([content], { type: "text/plain" }), filename, isEffectCurrent);
}

/** Same guarded handoff for byte-composed files; never stringify a bulk backup. */
export async function downloadFileBlob(
  content: Blob,
  filename: string,
  isEffectCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!isEffectCurrent()) return false;
  if (Capacitor.isNativePlatform()) {
    try {
      // Reuse the owned file handoff: unique sanitized Cache path, an authority
      // check after asynchronous preparation, and deletion after share/cancel.
      // Do not retain readable exports or recovery material in Documents.
      const { shareFile } = await import("@/lib/share/share-file");
      await shareFile({ file: new File([content], filename, { type: content.type }),
        title: "Save your file", isEffectCurrent });
      if (isEffectCurrent()) toast.success("Saved", { duration: 5000 });
      return true;
    } catch {
      if (isEffectCurrent()) toast.error("Not saved yet. Choose a destination, or copy it instead.", { duration: 6000 });
      // Never replay a cancelled or uncertain native handoff as a web download.
      return false;
    }
  }

  let url: string | null = null;
  let anchor: HTMLAnchorElement | null = null;
  try {
    if (!isEffectCurrent()) return false;
    url = URL.createObjectURL(content);
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    return true;
  } catch {
    if (isEffectCurrent()) toast.error("Failed to download file");
    return false;
  } finally {
    anchor?.remove();
    if (url) URL.revokeObjectURL(url);
  }
}

export async function blobToBase64String(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to encode file"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file reader result"));
        return;
      }
      const parts = result.split(",");
      resolve(parts[1] || "");
    };
    reader.readAsDataURL(blob);
  });
}

export async function downloadBlobFile(
  blob: Blob,
  filename: string,
  mimeType = "application/octet-stream"
): Promise<boolean> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Filesystem, Directory } = (await import(
        "@capacitor/filesystem"
      )) as typeof import("@capacitor/filesystem");

      const base64 = await blobToBase64String(blob);
      await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Documents,
        recursive: true,
      });
      return true;
    } catch (error) {
      console.error("[Download] Native blob save failed:", error);
      return false;
    }
  }

  try {
    const typedBlob =
      blob.type === mimeType || !mimeType ? blob : new Blob([blob], { type: mimeType });
    const url = URL.createObjectURL(typedBlob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch (error) {
    console.error("[Download] Browser blob download failed:", error);
    return false;
  }
}

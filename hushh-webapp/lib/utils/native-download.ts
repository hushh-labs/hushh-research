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
  filename: string
): Promise<boolean> {
  const platform = Capacitor.getPlatform();
  const isNative = Capacitor.isNativePlatform();

  console.log("[Download] Starting download for:", filename);
  console.log("[Download] Platform:", platform, "isNative:", isNative);

  // Native platforms: Use Filesystem to write to Documents
  if (isNative) {
    try {
      // Dynamic import to avoid bundling issues on web
      const { Filesystem, Directory, Encoding } = (await import(
        "@capacitor/filesystem"
      )) as typeof import("@capacitor/filesystem");

      console.log("[Download] Writing file to Documents directory...");

      // Write to Documents directory - accessible on both platforms
      const result = await Filesystem.writeFile({
        path: filename,
        data: content,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });

      console.log("[Download] File written successfully:", result.uri);

      // The written file lives in a directory the person cannot browse to, so
      // it is only really "saved" once they have put it somewhere themselves.
      const { Share } = (await import(
        "@capacitor/share"
      )) as typeof import("@capacitor/share");

      try {
        await Share.share({
          title: filename,
          files: [result.uri],
          dialogTitle: "Save your file",
        });
      } catch (shareError) {
        // Cancelling the sheet lands here too, and a cancel is not a save.
        console.warn("[Download] Share sheet dismissed or failed:", shareError);
        toast.error("Not saved yet. Choose a destination, or copy it instead.", {
          duration: 6000,
        });
        return false;
      }

      toast.success("Saved", { duration: 5000 });
      return true;
    } catch (error) {
      console.error("[Download] Native save failed:", error);
      toast.error("Failed to save file. Please try again or use copy instead");
      // Fall through to web method as backup
    }
  }

  // Web fallback (also used if native fails)
  try {
    console.log("[Download] Using web fallback...");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log("[Download] Web download triggered");
    return true;
  } catch (error) {
    console.error("[Download] All download methods failed:", error);
    toast.error("Failed to download file");
    return false;
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

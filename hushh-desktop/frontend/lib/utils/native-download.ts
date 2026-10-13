import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";

/**
 * Cross-platform file download utility
 *
 * Platform behavior:
 * - iOS: Saves to app's Documents folder, visible in Files app under "On My iPhone" > "Hussh"
 *        (Requires UIFileSharingEnabled=true in Info.plist)
 * - Android: Saves to app's Documents folder, visible in file manager
 * - Web: Standard browser download to Downloads folder
 *
 * Non-breaking: Falls back to web method if native fails
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

      // Show platform-specific success message
      if (platform === "ios") {
        toast.success("Saved to Files app", {
          description: `Check "On My iPhone" → "Hussh" → ${filename}`,
          duration: 5000,
        });
      } else {
        // Android
        toast.success("Saved to Documents", {
          description: filename,
          duration: 5000,
        });
      }

      return true;
    } catch (error) {
      console.error("[Download] Native save failed:", error);
      toast.error("Failed to save file", {
        description: "Please try again or use copy instead",
      });
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

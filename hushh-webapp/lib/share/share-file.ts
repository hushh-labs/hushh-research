import { Capacitor } from "@capacitor/core";
import { blobToBase64String, downloadBlobFile } from "@/lib/utils/native-download";
import type { NativeWorkspaceChoice } from "@/lib/capacitor/native-workspace";
import { nativeDrawers } from "@/lib/capacitor/native-drawers";
import { isShareCancellationError } from "./share-link";

/** The file must be prepared before the click so Web Share keeps user activation. */
export async function shareFile({ file, title, isEffectCurrent = () => true, workspaceChoice }: { file: File; title: string; isEffectCurrent?: () => boolean; workspaceChoice?: NativeWorkspaceChoice }): Promise<"native-share" | "web-share" | "download"> {
  const requireCurrent = () => { if (!isEffectCurrent()) throw new DOMException("The file request expired.", "AbortError"); };
  requireCurrent();
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"), import("@capacitor/share"),
    ]);
    // A peer-supplied filename must never become a cache path traversal.
    const leaf = file.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "_").slice(0, 180) || "attachment";
    const directory = `shared-cards/${crypto.randomUUID()}`;
    const path = `${directory}/${leaf}`;
    const data = await blobToBase64String(file);
    requireCurrent();
    try {
      const result = await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
      requireCurrent();
      if (workspaceChoice) {
        const share = nativeDrawers().shareWorkspaceFile;
        if (!share) throw new Error("Native Wallet sharing is unavailable");
        await share({ ...workspaceChoice, fileUri: result.uri, title });
      } else await Share.share({ title, files: [result.uri], dialogTitle: title });
      return "native-share";
    } finally {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
      await Filesystem.rmdir({ path: directory, directory: Directory.Cache }).catch(() => undefined);
    }
  }

  let supportsFiles = false;
  try {
    supportsFiles = typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch { /* Unsupported file capability falls back to a download. */ }
  if (supportsFiles) {
    try {
      requireCurrent();
      await navigator.share({ title, files: [file] });
      return "web-share";
    } catch (error) {
      if (isShareCancellationError(error)) throw error;
    }
  }
  requireCurrent();
  if (await downloadBlobFile(file, file.name, file.type)) return "download";
  throw new Error("The file could not be shared.");
}

import { Capacitor } from "@capacitor/core";
import { blobToBase64String, downloadBlobFile } from "@/lib/utils/native-download";
import { isShareCancellationError } from "./share-link";

/** The file must be prepared before the click so Web Share keeps user activation. */
export async function shareFile({ file, title }: { file: File; title: string }): Promise<"native-share" | "web-share" | "download"> {
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"), import("@capacitor/share"),
    ]);
    const path = `shared-cards/${crypto.randomUUID()}/${file.name}`;
    const result = await Filesystem.writeFile({ path, data: await blobToBase64String(file), directory: Directory.Cache, recursive: true });
    try {
      await Share.share({ title, files: [result.uri], dialogTitle: title });
      return "native-share";
    } finally {
      await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined);
    }
  }

  let supportsFiles = false;
  try {
    supportsFiles = typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
  } catch { /* Unsupported file capability falls back to a download. */ }
  if (supportsFiles) {
    try {
      await navigator.share({ title, files: [file] });
      return "web-share";
    } catch (error) {
      if (isShareCancellationError(error)) throw error;
    }
  }
  if (await downloadBlobFile(file, file.name, file.type)) return "download";
  throw new Error("The card image could not be shared.");
}

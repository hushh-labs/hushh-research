import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";

/** Export owner Drive notes only after a complete stream and an explicit click. */
export async function exportPrivateDriveMarkdown(
  markdown: string,
  filename: string,
): Promise<boolean> {
  if (!markdown || !/^drive-notes-\d{4}-\d{2}-\d{2}\.md$/.test(filename)) {
    return false;
  }

  if (!Capacitor.isNativePlatform()) {
    try {
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return true;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      toast.error("Could not download the notes. Please try again.");
      return false;
    }
  }

  // Native sharing requires a file URI. Keep it in app cache only while the
  // share sheet is open, then remove it on success, cancel, or error.
  let filesystem: typeof import("@capacitor/filesystem");
  let share: typeof import("@capacitor/share");
  try {
    [filesystem, share] = await Promise.all([
      import("@capacitor/filesystem"), import("@capacitor/share"),
    ]);
  } catch {
    toast.error("Could not prepare the notes for sharing. Please try again.");
    return false;
  }
  const { Filesystem, Directory, Encoding } = filesystem;
  const { Share } = share;
  const path = `${crypto.randomUUID()}-${filename}`;
  let shared = false;
  let cleanupFailed = false;
  let attemptedWrite = false;
  try {
    attemptedWrite = true;
    const { uri } = await Filesystem.writeFile({
      path,
      data: markdown,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: filename, files: [uri], dialogTitle: "Save your notes" });
    shared = true;
  } catch {
    // A canceled share sheet is not a saved download.
  } finally {
    if (attemptedWrite) {
      try {
        await Filesystem.deleteFile({ path, directory: Directory.Cache });
      } catch {
        cleanupFailed = true;
      }
    }
  }
  if (cleanupFailed) {
    toast.error("A temporary copy of the notes could not be removed from app cache.");
    return false;
  }
  if (!shared) {
    toast.error("Notes were not saved. Please try again.");
    return false;
  }
  toast.success("Notes saved");
  return true;
}

import { copyToClipboard } from "@/lib/utils/clipboard";

export type CircleCodeShareDelivery =
  | "native-share"
  | "web-share"
  | "copied";

export function isShareCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message =
    typeof candidate.message === "string" ? candidate.message.trim() : "";
  return (
    name === "AbortError" ||
    /^share cancell?ed$/i.test(message)
  );
}

/**
 * Share a short-lived Circle invite. When a `url` is supplied it is included as
 * a dedicated, clickable link in the native/web share sheet so the recipient can
 * tap straight into the join flow; the caller-supplied `text` still carries the
 * same human-safe consent explanation (and the raw code) as the clipboard/text
 * fallback for targets that ignore the url field.
 *
 * Capacitor owns the native iOS/Android sheet; browsers use Web Share and then
 * the shared clipboard fallback.
 */
export async function shareNamedCircleCode(params: {
  title: string;
  text: string;
  dialogTitle: string;
  url?: string;
}): Promise<CircleCodeShareDelivery> {
  const url = params.url?.trim() ? params.url.trim() : undefined;
  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    const { Share } =
      (await import("@capacitor/share")) as typeof import("@capacitor/share");
    await Share.share({
      title: params.title,
      text: params.text,
      dialogTitle: params.dialogTitle,
      ...(url ? { url } : {}),
    });
    return "native-share";
  }

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function"
  ) {
    await navigator.share({
      title: params.title,
      text: params.text,
      ...(url ? { url } : {}),
    });
    return "web-share";
  }

  // Clipboard fallback keeps the link alongside the text so nothing is lost when
  // neither native nor Web Share is available.
  const clipboardText = url ? `${params.text}\n${url}` : params.text;
  if (await copyToClipboard(clipboardText)) return "copied";
  throw new Error("Sharing is not supported on this device.");
}

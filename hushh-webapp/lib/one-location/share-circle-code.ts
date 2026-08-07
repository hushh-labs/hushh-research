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
 * Share a short-lived Circle code without putting it in a URL.
 *
 * Capacitor owns the native iOS/Android sheet; browsers use Web Share and then
 * the shared clipboard fallback. The caller supplies the complete, human-safe
 * text so every platform receives the same consent explanation.
 */
export async function shareNamedCircleCode(params: {
  title: string;
  text: string;
  dialogTitle: string;
}): Promise<CircleCodeShareDelivery> {
  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    const { Share } =
      (await import("@capacitor/share")) as typeof import("@capacitor/share");
    await Share.share({
      title: params.title,
      text: params.text,
      dialogTitle: params.dialogTitle,
    });
    return "native-share";
  }

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function"
  ) {
    await navigator.share({ title: params.title, text: params.text });
    return "web-share";
  }

  if (await copyToClipboard(params.text)) return "copied";
  throw new Error("Sharing is not supported on this device.");
}

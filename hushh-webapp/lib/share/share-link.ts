import { copyToClipboard } from "@/lib/utils/clipboard";

/**
 * Handing a link to whatever the device uses for sharing.
 *
 * Extracted from `lib/one-location/share-circle-code.ts`, where this ladder was
 * written first and named after the one thing that needed it. The behaviour was
 * never Circle-specific -- native sheet, then Web Share, then the clipboard --
 * and a second surface asking to share something should not have to import a
 * function called `shareNamedCircleCode` to do it, nor copy the ladder and let
 * the two drift.
 */

export type ShareDelivery = "native-share" | "web-share" | "copied";

/**
 * A share the person dismissed.
 *
 * Both Web Share and the Capacitor sheet report a cancelled share as a thrown
 * error, so a caller that treats every rejection as a failure shows an error
 * toast to somebody who simply changed their mind. Every caller checks this
 * first.
 */
export function isShareCancellationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message =
    typeof candidate.message === "string" ? candidate.message.trim() : "";
  return name === "AbortError" || /^share cancell?ed$/i.test(message);
}

/**
 * The device offered no way to share at all.
 *
 * Distinct from a share that failed: every rung of the ladder was tried and
 * none of them exists here -- no native sheet, no Web Share, and a clipboard
 * that refused. It is thrown rather than returned because callers already
 * branch on `catch`, and a caller that forgot to check a returned failure code
 * would quietly report success. Callers that want to say something more useful
 * than "that did not work" check for it by instance rather than by matching
 * the message, which is free to change.
 */
export class ShareUnavailableError extends Error {
  constructor() {
    super("Sharing is not supported on this device.");
    this.name = "ShareUnavailableError";
  }
}

/**
 * Share text, and optionally a link, through the best channel this device has.
 *
 * When a `url` is supplied it is the ONLY place the link should appear: most
 * share targets (WhatsApp, Messages) append `url` to `text`, so a link repeated
 * inside `text` is delivered twice. Callers keep `text` link-free and let it
 * carry the human-readable part.
 *
 * Capacitor owns the native iOS/Android sheet; browsers use Web Share and then
 * the clipboard, which keeps the link alongside the text so nothing is lost
 * where neither exists.
 */
export async function shareLink(params: {
  title: string;
  text: string;
  dialogTitle: string;
  url?: string;
}): Promise<ShareDelivery> {
  const url = params.url?.trim() ? params.url.trim() : undefined;
  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    const { Share } = (await import(
      "@capacitor/share"
    )) as typeof import("@capacitor/share");
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

  const clipboardText = url ? `${params.text}\n${url}` : params.text;
  if (await copyToClipboard(clipboardText)) return "copied";
  throw new ShareUnavailableError();
}

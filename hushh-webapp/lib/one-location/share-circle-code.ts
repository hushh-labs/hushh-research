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
 * How a Circle is named inside share copy ("Join my <label> on One …").
 *
 * The copy appends the word "Circle" so a bare name like "K Family" reads as a
 * group. Names that already end in "Circle" — every default onboarding name is
 * `<First>'s Circle` — would otherwise be delivered as "JHUMMA's Circle Circle",
 * so the suffix is only added when the name does not already carry it.
 */
export function circleShareLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "Circle";
  return /\bcircles?$/i.test(trimmed) ? trimmed : `${trimmed} Circle`;
}

/**
 * Share a short-lived Circle invite. When a `url` is supplied it is the ONLY
 * place the join link appears: most share targets (WhatsApp, Messages) append
 * `url` to `text`, so a link repeated inside `text` is delivered twice. Callers
 * therefore keep `text` link-free and let it carry the human-safe consent
 * explanation plus the raw code — which is what targets that ignore the url
 * field fall back to, since the code alone is enough to join.
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

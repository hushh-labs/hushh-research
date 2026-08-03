"use client";

import { Capacitor } from "@capacitor/core";

import { copyToClipboard } from "@/lib/utils/clipboard";

export type WalletCardShareOutcome = "native-share" | "web-share" | "copied";

export function isShareAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Share the public profile link.
 *
 * Native share sheet on device, Web Share where the browser offers it, and the
 * clipboard as the last resort — the same ladder One Location uses so sharing
 * behaves identically across the app.
 *
 * Adding the pass to Apple Wallet is a different path entirely and belongs to
 * `WalletCardService.addToAppleWallet`, which hands the URL to the OS because
 * WKWebView cannot import a `.pkpass`.
 */
export async function shareWalletCardLink(params: {
  title: string;
  text: string;
  url: string;
  dialogTitle: string;
}): Promise<WalletCardShareOutcome> {
  const url = params.url.trim();
  if (!url) {
    throw new Error("There is no share link on this device yet.");
  }
  const message = `${params.text}\n${url}`;

  if (Capacitor.isNativePlatform()) {
    const { Share } =
      (await import("@capacitor/share")) as typeof import("@capacitor/share");
    if (Capacitor.getPlatform() === "android") {
      // Android share targets drop the `url` field, so it is folded into the text.
      await Share.share({
        title: params.title,
        text: message,
        dialogTitle: params.dialogTitle,
      });
      return "native-share";
    }
    await Share.share({
      title: params.title,
      text: params.text,
      url,
      dialogTitle: params.dialogTitle,
    });
    return "native-share";
  }

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    await navigator.share({ title: params.title, text: params.text, url });
    return "web-share";
  }

  if (await copyToClipboard(message)) {
    return "copied";
  }

  throw new Error("Sharing is not supported on this device.");
}

/** Copy just the link, with no surrounding message. */
export async function copyWalletCardLink(url: string): Promise<boolean> {
  const trimmed = url.trim();
  if (!trimmed) return false;
  return copyToClipboard(trimmed);
}

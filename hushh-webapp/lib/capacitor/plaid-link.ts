import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Plaid Link through Plaid's native SDK (LinkKit on iOS, the Link SDK on
 * Android). The web Link SDK inside the WebView cannot finish an OAuth bank:
 * its OAuth leg leaves the app for the system browser and the return never
 * reaches the app. The native SDK owns that leg. `open` resolves once: a
 * public token on success, or an exit with the reason; the page exchanges the
 * token with the backend as it does on the web. Nothing is stored natively.
 */
export interface HushhPlaidLinkPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  open(options: { token: string }): Promise<HushhPlaidLinkResult>;
  addListener(
    eventName: "plaidLinkEvent",
    listener: (event: { eventName: string; metadata: Record<string, unknown> }) => void,
  ): Promise<PluginListenerHandle>;
}

export type HushhPlaidLinkResult =
  | { publicToken: string; metadata: Record<string, unknown>; exit?: undefined }
  | {
      exit: true;
      metadata: Record<string, unknown>;
      error?: { code: string; message: string; displayMessage?: string };
    };

export const HushhPlaidLink = registerPlugin<HushhPlaidLinkPlugin>("HushhPlaidLink");

/** The Link runtime a link token is minted for; the backend shapes the token by it. */
export type PlaidLinkPlatform = "web" | "ios" | "android";

let nativeAvailability: Promise<boolean> | null = null;

/**
 * Whether this shell opens Plaid through the native SDK. The plugin must be
 * compiled in and must say the device is supported (Android below 8.0 is
 * not); otherwise the page uses web Link. Resolved once per app session.
 */
export function isNativePlaidLinkAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable("HushhPlaidLink")) {
    return Promise.resolve(false);
  }
  nativeAvailability ??= HushhPlaidLink.isAvailable()
    .then((result) => result.available === true)
    .catch(() => false);
  return nativeAvailability;
}

/**
 * The platform to mint a link token for. Android only when the native SDK
 * will open it: that token carries the app's package name and no redirect
 * URI, which web Link could not use. iOS keeps the redirect URI either way.
 */
export async function resolvePlaidLinkPlatform(): Promise<PlaidLinkPlatform> {
  const platform = Capacitor.getPlatform();
  if (platform === "android") {
    return (await isNativePlaidLinkAvailable()) ? "android" : "web";
  }
  if (platform === "ios") return "ios";
  return "web";
}

/** Test seam: forget the cached native availability. */
export function resetNativePlaidLinkAvailabilityForTests(): void {
  nativeAvailability = null;
}

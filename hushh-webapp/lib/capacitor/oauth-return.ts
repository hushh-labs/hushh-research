import { registerPlugin } from "@capacitor/core";

/**
 * The plugin catches an app-owned OAuth return in the WebView and can open
 * a custom MCP server's authorization URL in the system browser. A provider flow ends by
 * navigating the top frame to the app's https `/oauth/return` route; on the
 * native shell that host is not the app's origin and would open the system
 * browser, where no session exists. The plugin cancels that navigation and
 * delivers the URL as the App plugin's `appUrlOpen`, which
 * `lib/navigation/use-deep-link-return.ts` already routes in place.
 */
const NATIVE_APP_LINK_HOSTS = new Set([
  "one.hushh.ai", "uat.one.hushh.ai", "dev.one.hushh.ai",
]);

/** Localhost callbacks cannot return to a packaged app. Never start a doomed native flow. */
export function isNativeCustomConnectorReturnUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && NATIVE_APP_LINK_HOSTS.has(url.hostname) &&
      url.port === "" && url.username === "" && url.password === "" &&
      url.pathname === "/one/profile/connectors/oauth/return" &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export interface HushhOAuthReturnPlugin {
  /** Launch only; backend OAuth completion and vault save remain in the app callback. */
  openAuthorization(options: {
    authorizeUrl: string;
    redirectUri: string;
    attemptId: string;
    expectedUserId: string;
  }): Promise<void>;
}

export const HushhOAuthReturn = registerPlugin<HushhOAuthReturnPlugin>("HushhOAuthReturn");

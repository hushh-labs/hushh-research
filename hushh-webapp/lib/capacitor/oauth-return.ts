import { registerPlugin } from "@capacitor/core";
import { SANDBOX_IOS_APP_ID, SANDBOX_ANDROID_APP_ID, sandboxNativeFrontendOrigin } from "./scope-commerce-sandbox-links.mjs";

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
    const sandboxOrigin = sandboxNativeFrontendOrigin({
      sandboxOrigin: process.env.NEXT_PUBLIC_SCOPE_COMMERCE_SANDBOX_ORIGIN,
      frontendOrigin: process.env.NEXT_PUBLIC_APP_URL,
      iosAppId: process.env.NEXT_PUBLIC_IOS_BUNDLE_ID,
      androidAppId: process.env.NEXT_PUBLIC_ANDROID_APP_ID,
    });
    const sandboxBuild = Boolean(process.env.NEXT_PUBLIC_SCOPE_COMMERCE_SANDBOX_ORIGIN) ||
      process.env.NEXT_PUBLIC_IOS_BUNDLE_ID === SANDBOX_IOS_APP_ID || process.env.NEXT_PUBLIC_ANDROID_APP_ID === SANDBOX_ANDROID_APP_ID;
    return url.protocol === "https:" && (sandboxBuild ? sandboxOrigin !== null && url.origin === sandboxOrigin : NATIVE_APP_LINK_HOSTS.has(url.hostname)) &&
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

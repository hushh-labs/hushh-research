import { registerPlugin } from "@capacitor/core";

/**
 * Native-only, no methods: the plugin lives in the WebView's navigation
 * policy. A provider OAuth flow (Plaid, Alpaca, Google, Gmail) ends by
 * navigating the top frame to the app's https `/oauth/return` route; on the
 * native shell that host is not the app's origin and would open the system
 * browser, where no session exists. The plugin cancels that navigation and
 * delivers the URL as the App plugin's `appUrlOpen`, which
 * `lib/navigation/use-deep-link-return.ts` already routes in place.
 */
// No methods by design; the parity verifier reads the interface.
export interface HushhOAuthReturnPlugin {}

export const HushhOAuthReturn = registerPlugin<HushhOAuthReturnPlugin>("HushhOAuthReturn");

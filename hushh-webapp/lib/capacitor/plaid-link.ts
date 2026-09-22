import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * Plaid Link through Plaid's native SDK on iOS (LinkKit). The web Link SDK
 * inside the WebView cannot finish an OAuth bank: its OAuth leg leaves the
 * app for the system browser and the return never reaches the app. LinkKit
 * owns that leg. `open` resolves once: a public token on success, or an
 * exit with the reason; the page exchanges the token with the backend as it
 * does on the web. Nothing is stored natively.
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

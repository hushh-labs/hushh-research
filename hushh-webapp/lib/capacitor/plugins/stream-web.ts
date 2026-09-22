import { WebPlugin } from "@capacitor/core";

import type { HushhStreamPlugin } from "../stream";

/**
 * Web stand-in for the native streaming transport. The browser's own
 * `fetch()` already streams a response body, so on web
 * `nativeStreamFetch` never reaches this class; it exists so the plugin
 * registry has a web implementation and a mistaken call fails loudly.
 */
export class HushhStreamWeb extends WebPlugin implements HushhStreamPlugin {
  async open(): Promise<{ status: number; headers: Record<string, string> }> {
    throw new Error("HushhStream is native-only; use fetch on web");
  }

  async cancel(): Promise<{ cancelled: boolean }> {
    return { cancelled: false };
  }
}

/**
 * HushhStream Plugin Interface
 *
 * A generic streaming HTTP transport for the native shells. WKWebView buffers
 * a `fetch()` response body until the request completes, and the app routes
 * every native call through CapacitorHttp (whole bodies), so a server-sent
 * event stream reaches the page only when it has ended. This plugin performs
 * the request natively (URLSession / OkHttp) and forwards the raw response
 * bytes as they arrive; `lib/services/native-sse-fetch.ts` turns them back
 * into a streaming `Response` for callers that already speak `fetch`.
 *
 * It carries bytes, not meaning: no SSE parsing, no JSON, no retry. The
 * caller sets the headers (the vault-owner bearer travels exactly as it does
 * through CapacitorHttp today) and the backend URL is resolved the way every
 * other plugin resolves it (`HushhProxyClient` / `BackendUrl`).
 */

import { registerPlugin } from "@capacitor/core";

/** Event name for native stream chunks and completion. */
export const HUSHH_STREAM_EVENT = "hushhStreamEvent";

export type HushhStreamEvent = {
  /** The id the caller chose in `open()`; one listener serves every stream. */
  streamId: string;
  /** `chunk` carries `base64`; `end` closes the stream, with `error`/`code` on failure. */
  type: "chunk" | "end";
  /** Base64 of the raw response bytes (a multi-byte character may split across chunks). */
  base64?: string;
  /** Present on a failed `end`: a short native error description. */
  error?: string;
  /** Present on a failed `end`: `CANCELLED`, `TIMEOUT`, `NETWORK`, or `HUSHH_HTTP_<status>`. */
  code?: string;
};

export interface HushhStreamPlugin {
  /**
   * Start the request. Resolves when the response headers have arrived (so a
   * non-2xx status is known before any body byte), and the body then arrives
   * as `chunk` events until one `end` event.
   */
  open(options: {
    streamId: string;
    /** App-relative path (`/api/...`) resolved against the configured backend, or an absolute URL. */
    path: string;
    method: string;
    headers: Record<string, string>;
    /** Request body as text (JSON for the chat endpoint). */
    body?: string;
  }): Promise<{ status: number; headers: Record<string, string> }>;

  /** Cancel a stream; an `end` event with `code: "CANCELLED"` follows. */
  cancel(options: { streamId: string }): Promise<{ cancelled: boolean }>;

  addListener(
    eventName: typeof HUSHH_STREAM_EVENT,
    listenerFunc: (event: HushhStreamEvent) => void,
  ): Promise<{ remove: () => void }>;
}

export const HushhStream = registerPlugin<HushhStreamPlugin>("HushhStream", {
  web: () => import("./plugins/stream-web").then((m) => new m.HushhStreamWeb()),
});

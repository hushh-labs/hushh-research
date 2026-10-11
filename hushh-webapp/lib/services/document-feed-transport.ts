import { Capacitor } from "@capacitor/core";

import { ApiService } from "@/lib/services/api-service";
import { nativeStreamFetch } from "@/lib/services/native-sse-fetch";

/** Fixed endpoint only. Native must use HushhStream, never buffered CapacitorHttp. */
export function openDocumentFeedStream(uid: string, token: string, signal: AbortSignal): Promise<Response> {
  const path = `/api/consent/document-feed/${encodeURIComponent(uid)}`;
  const options: RequestInit = {
    method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
    signal, cache: "no-store",
  };
  return Capacitor.isNativePlatform()
    ? nativeStreamFetch(path, options)
    : ApiService.apiFetchStream(path, options);
}

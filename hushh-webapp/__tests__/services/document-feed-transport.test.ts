import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ native: false, web: vi.fn(), nativeStream: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => state.native } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetchStream: state.web } }));
vi.mock("@/lib/services/native-sse-fetch", () => ({ nativeStreamFetch: state.nativeStream }));
import { openDocumentFeedStream } from "@/lib/services/document-feed-transport";

afterEach(() => { vi.clearAllMocks(); });

it.each([false, true])("uses a fixed authenticated stream with real cancellation (native=%s)", async (native) => {
  state.native = native;
  const controller = new AbortController();
  const selected = native ? state.nativeStream : state.web;
  const other = native ? state.web : state.nativeStream;
  selected.mockResolvedValue(new Response());
  await openDocumentFeedStream("owner/with-space", "test-bearer", controller.signal);
  expect(selected).toHaveBeenCalledWith("/api/consent/document-feed/owner%2Fwith-space", {
    method: "GET", cache: "no-store", signal: controller.signal,
    headers: { Authorization: "Bearer test-bearer", Accept: "text/event-stream" },
  });
  expect(other).not.toHaveBeenCalled();
});

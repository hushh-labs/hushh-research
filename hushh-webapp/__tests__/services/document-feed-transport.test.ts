import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ apiFetchStream: vi.fn(), nativeStream: vi.fn() }));
vi.mock("@/lib/services/api-service", () => ({
  // No direct backend origin configured: the web goes straight to its proxy.
  getDirectBackendUrl: () => "",
  ApiService: { apiFetchStream: state.apiFetchStream },
}));
vi.mock("@/lib/services/native-sse-fetch", () => ({ nativeStreamFetch: state.nativeStream }));
import { createDocumentFeedTransport } from "@/lib/services/document-feed-transport";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(["web", "native"] as const)("uses a fixed authenticated stream with real cancellation (%s)", async (platform) => {
  const web = vi.fn(async () => new Response(null));
  vi.stubGlobal("fetch", web);
  state.nativeStream.mockResolvedValue(new Response(null));
  const controller = new AbortController();
  await createDocumentFeedTransport(platform).open({
    uid: "owner/with-space",
    token: "test-bearer",
    signal: controller.signal,
  });
  const selected = platform === "native" ? state.nativeStream : web;
  const other = platform === "native" ? web : state.nativeStream;
  expect(selected).toHaveBeenCalledWith("/api/consent/document-feed/owner%2Fwith-space?v=2", expect.objectContaining({
    method: "GET", cache: "no-store", signal: controller.signal,
    headers: { Authorization: "Bearer test-bearer", Accept: "text/event-stream" },
  }));
  expect(other).not.toHaveBeenCalled();
  // Never apiFetch: native would buffer, and its 401 replay could sign the user out.
  expect(state.apiFetchStream).not.toHaveBeenCalled();
});

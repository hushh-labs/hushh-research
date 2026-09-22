import { expect, it, vi } from "vitest";
import { GeminiLiveClient } from "@/lib/services/gemini-live-client";
it("retired clients cannot open a socket or request generated audio", () => {
 const socket=vi.fn(); const fetch=vi.fn(); vi.stubGlobal("WebSocket",socket); vi.stubGlobal("fetch",fetch);
 expect(() => new GeminiLiveClient()).toThrow("ONE_LIVE_RETIRED");
 expect(socket).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

import { afterEach, expect, it, vi } from "vitest";
import "../fixtures/api-service-mocks";
import { deferred, jsonResponse } from "../fixtures/api-service-responses";
import { AuthService } from "@/lib/services/auth-service";
import { ApiService } from "@/lib/services/api-service";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("does not dispatch managed AI selection after its visit retires during token acquisition", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const token = deferred<string | null>();
  vi.mocked(AuthService.getIdToken).mockReturnValueOnce(token.promise);
  let current = true;
  const request = ApiService.selectManagedGeminiRuntime(() => current);
  current = false;
  token.resolve("synthetic-token");
  await expect(request).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();

  vi.mocked(AuthService.getIdToken).mockResolvedValueOnce("synthetic-token");
  fetch.mockResolvedValueOnce(jsonResponse({ status: "ready", model: "fixture", location: "global", agentScheduled: false, agentReason: "" }));
  current = true;
  await expect(ApiService.selectManagedGeminiRuntime(() => current)).resolves.toMatchObject({ status: "ready" });
  expect(fetch).toHaveBeenCalledOnce();
});

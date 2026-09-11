/**
 * The personal-agent status call must carry a bearer, and must surface hushhId.
 *
 * The dashboard chip and the Feed follow loop both read this endpoint through
 * `useAgentDeploymentFollow`. That hook called `apiJson("/api/one/personal-agent/status")`
 * with no second argument — and `apiFetch` does NOT attach auth, every caller supplies
 * its own. So `require_firebase_auth` 401'd every poll, the hook's `catch` treated it as
 * "a transient status failure is not a state change", and the chip sat on `reserved`
 * forever regardless of what the registry actually said.
 *
 * The second half matters more for the pod programme: the client's response type declared
 * only `{ state }`, so `hushhId` — which the backend has always sent, and which is the
 * address every pod-facing call is keyed on — was discarded. A pod could be live and
 * serving and nothing in the product could name it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdToken: vi.fn(async () => "firebase-id-token") },
}));

// Spread the real module: `api-service` pulls in `lib/capacitor/index.ts`, which calls
// `registerPlugin` at import time, so a shallow mock breaks the import graph rather
// than the platform check we actually want to pin.
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => false, getPlatform: () => "web" },
  };
});

import { ApiService } from "@/lib/services/api-service";

function mockFetchOnce(body: unknown, ok = true, status = 200) {
  const spy = vi.spyOn(ApiService, "apiFetch").mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
  return spy;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ApiService.getPersonalAgentStatus", () => {
  it("sends an Authorization bearer", async () => {
    const spy = mockFetchOnce({ state: "active" });
    await ApiService.getPersonalAgentStatus();

    expect(spy).toHaveBeenCalledTimes(1);
    const [path, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/one/personal-agent/status");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer firebase-id-token");
  });

  it("returns hushhId rather than discarding it", async () => {
    mockFetchOnce({ state: "active", hushhId: "HA1XYZ", featureEnabled: true });
    const res = await ApiService.getPersonalAgentStatus();

    // The address the pod relay is keyed on. A narrower type here is what made
    // every pod in the fleet unreachable from the product.
    expect(res.hushhId).toBe("HA1XYZ");
    expect(res.state).toBe("active");
  });

  it("passes health through only when the backend actually sent it", async () => {
    mockFetchOnce({ state: "active", health: "healthy", lastSeenAt: "2026-08-11T00:00:00Z" });
    const withHealth = await ApiService.getPersonalAgentStatus();
    expect(withHealth.health).toBe("healthy");

    mockFetchOnce({ state: "provisioning" });
    const without = await ApiService.getPersonalAgentStatus();
    // Absent means absent. The backend deliberately omits health rather than
    // defaulting it to "healthy", and the client must not invent one either.
    expect(without.health).toBeUndefined();
  });

  it("throws on a non-ok response instead of reporting a state", async () => {
    mockFetchOnce(null, false, 401);
    // The hook's catch keeps the last known value. That is only correct if a
    // failed call actually raises — silently returning a parsed body would let a
    // 401 body masquerade as agent state.
    await expect(ApiService.getPersonalAgentStatus()).rejects.toThrow(
      "AGENT_STATUS_UNAVAILABLE:401",
    );
  });
});

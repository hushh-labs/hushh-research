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

const authState = vi.hoisted(() => ({
  user: null as { uid: string } | null,
  native: false,
  nativeToken: vi.fn(),
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn(async () => "firebase-id-token"),
    getCurrentUser: vi.fn(() => authState.user),
  },
}));

// Spread the real module: `api-service` pulls in `lib/capacitor/index.ts`, which calls
// `registerPlugin` at import time, so a shallow mock breaks the import graph rather
// than the platform check we actually want to pin.
vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => authState.native, getPlatform: () => authState.native ? "ios" : "web" },
  };
});

import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";
vi.mock("@/lib/capacitor", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/capacitor")>(),
  HushhAuth: { getIdToken: authState.nativeToken },
}));

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
  ApiService.clearRoutingHostingBurstCache();
  publishValidatedAuthSessionPrincipal(null);
  authState.user = null;
  authState.native = false;
  authState.nativeToken.mockReset();
});

describe("ApiService.getPersonalAgentStatus", () => {
  it("carries the exact Browser plan digest through authenticated approval", async () => {
    const spy = mockFetchOnce({ operationId: "op_browser", status: "scheduled" });
    const input = { releaseId: "rel_browser", browserPlanDigest: "b".repeat(64), idempotencyKey: "same-click" };
    await ApiService.approvePersonalAgentUpdate(input);
    const [path, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/one/personal-agent/update/approve");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer firebase-id-token");
    expect(JSON.parse(init.body as string)).toEqual(input);
  });

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

  it("reuses settled byoc routing status within 5s, skips unsettled states, and invalidates on principal switch", async () => {
    authState.user = { uid: "fb-1" };
    publishValidatedAuthSessionPrincipal({
      firebaseUid: "fb-1",
      ownerId: "owner-1",
      accountGeneration: 1,
    });
    const spy = vi
      .spyOn(ApiService, "apiFetch")
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hostingMode: "byoc", state: "provisioning" }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hostingMode: "byoc", state: "active", hushhId: "ha1_1" }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hostingMode: "shared", state: "idle" }),
      } as unknown as Response);

    const unsettled = await ApiService.getPersonalAgentStatusForRouting();
    expect(unsettled.state).toBe("provisioning");
    const activeFirst = await ApiService.getPersonalAgentStatusForRouting();
    const activeSecond = await ApiService.getPersonalAgentStatusForRouting();
    expect(activeFirst.hushhId).toBe("ha1_1");
    expect(activeSecond.hushhId).toBe("ha1_1");
    expect(spy).toHaveBeenCalledTimes(2);

    authState.user = { uid: "fb-2" };
    publishValidatedAuthSessionPrincipal({
      firebaseUid: "fb-2",
      ownerId: "owner-2",
      accountGeneration: 2,
    });
    const switched = await ApiService.getPersonalAgentStatusForRouting();
    expect(switched.hostingMode).toBe("shared");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("routes a native-only session and discards a status from a retired sign-in of the same account", async () => {
    authState.native = true;
    const principal = { firebaseUid: "firebase-owner", ownerId: "application-owner", accountGeneration: 1 };
    publishValidatedAuthSessionPrincipal(principal);
    const token = `header.${btoa(JSON.stringify({ sub: principal.firebaseUid }))}.signature`;
    authState.nativeToken.mockResolvedValue({ idToken: token });
    let settle!: (response: Response) => void;
    const spy = vi.spyOn(ApiService, "apiFetch")
      .mockImplementationOnce(() => new Promise<Response>(resolve => { settle = resolve; }))
      .mockResolvedValueOnce(Response.json({ hostingMode: "shared", state: "active" }));
    const retired = ApiService.getPersonalAgentStatusForRouting();
    const rejected = expect(retired).rejects.toThrow("POD_OWNER_CHANGED");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    publishValidatedAuthSessionPrincipal(null);
    publishValidatedAuthSessionPrincipal(principal);
    await expect(ApiService.getPersonalAgentStatusForRouting()).resolves.toMatchObject({ hostingMode: "shared" });
    settle(Response.json({ hostingMode: "byoc", state: "active" }));
    await rejected;
    await expect(ApiService.getPersonalAgentStatusForRouting()).resolves.toMatchObject({ hostingMode: "shared" });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new Headers(spy.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("does not probe hosting with a native token from a different Firebase user", async () => {
    authState.native = true;
    publishValidatedAuthSessionPrincipal({ firebaseUid: "firebase-owner", ownerId: "application-owner", accountGeneration: 1 });
    authState.nativeToken.mockResolvedValue({
      idToken: `header.${btoa(JSON.stringify({ sub: "other-user" }))}.signature`,
    });
    const spy = mockFetchOnce({ hostingMode: "shared" });
    await expect(ApiService.getPersonalAgentStatusForRouting()).rejects.toThrow("PRIVATE_AGENT_SIGN_IN_REQUIRED");
    expect(spy).not.toHaveBeenCalled();
  });
});

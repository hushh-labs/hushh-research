import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { authSessionInvalidationCodeFromBackendPayload } from "@/lib/auth/session-invalidation";

vi.mock("@/app/api/_utils/backend", () => ({
  getPythonApiUrl: () => "http://backend.test",
}));

vi.mock("@/app/api/_utils/request-id", () => ({
  createUpstreamHeaders: (_requestId: string, headers: HeadersInit) => headers,
  resolveRequestId: () => "request-id",
  withRequestIdJson: (
    _requestId: string,
    payload: unknown,
    init?: ResponseInit,
  ) => Response.json(payload, init),
}));

vi.mock("@/lib/config", () => ({
  isDevelopment: () => false,
  logSecurityEvent: vi.fn(),
}));

vi.mock("@/lib/utils/request-timeouts", () => ({
  resolveSlowRequestTimeoutMs: (timeoutMs: number) => timeoutMs,
  isRequestTimeoutError: () => false,
}));

type VaultGetRoute = {
  GET: (request: NextRequest) => Promise<Response>;
};

let route: VaultGetRoute;

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  route = await import("../../app/api/vault/get/route");
});

function request(query: string, authHeader = "Bearer test-token") {
  return new NextRequest(`http://localhost:3000/api/vault/get?${query}`, {
    headers: { Authorization: authHeader },
  });
}

describe("GET /api/vault/get cache bypass for a forced (unlock) read", () => {
  it.each([
    { code: "AUTH_ACCOUNT_NOT_FOUND", error: "private-upstream-message" },
    { detail: { code: "AUTH_ACCOUNT_NOT_FOUND", message: "private-upstream-message" } },
  ].flatMap((payload) => [true, false].map((pending) => ({ payload, pending }))))(
    "preserves an explicit terminal401 and retires cached/pending metadata (%j)",
    async ({ payload, pending }) => {
      const terminal = deferredResponse();
      const later = deferredResponse();
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockReturnValueOnce(terminal.promise).mockReturnValueOnce(later.promise)
        .mockResolvedValueOnce(Response.json({ wrappers: [{ salt: "after-terminal" }] }));
      const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const first = route.GET(request("userId=terminal-user"));
      const second = route.GET(request("userId=terminal-user&fresh=1"));
      if (!pending) {
        later.resolve(Response.json({ wrappers: [{ salt: "before-terminal" }] }));
        await second;
      }
      terminal.resolve(Response.json(payload, { status: 401 }));
      const response = await first;
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Account not found", code: "AUTH_ACCOUNT_NOT_FOUND" });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain("private-upstream-message");
      if (pending) {
        later.resolve(Response.json({ wrappers: [{ salt: "before-terminal" }] }));
        await second;
      }
      const retried = await route.GET(request("userId=terminal-user"));
      await expect(retried.json()).resolves.toEqual({ wrappers: [{ salt: "after-terminal" }] });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { status: 401, payload: { error: "AUTH_ACCOUNT_NOT_FOUND" } },
    { status: 401, payload: { error: "Account not found", detail: { message: "AUTH_ACCOUNT_NOT_FOUND" } } },
    { status: 401, payload: { detail: { code: "AUTH_UNAUTHORIZED" } } },
    { status: 403, payload: { detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } } },
    { status: 400, payload: { code: "AUTH_ACCOUNT_NOT_FOUND" } },
  ])("does not infer terminal authority from prose, generic401 or non401 (%j)", async ({ status, payload }) => {
    const failure = deferredResponse();
    const later = deferredResponse();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockReturnValueOnce(failure.promise).mockReturnValueOnce(later.promise);
    const first = route.GET(request("userId=nonterminal-user"));
    const second = route.GET(request("userId=nonterminal-user&fresh=1"));
    failure.resolve(Response.json(payload, { status }));
    const response = await first;
    expect(response.status).toBe(status);
    const returned = await response.json();
    expect(authSessionInvalidationCodeFromBackendPayload(returned)).toBeNull();
    later.resolve(Response.json({ wrappers: [{ salt: "current" }] }));
    await second;
    const cached = await route.GET(request("userId=nonterminal-user"));
    await expect(cached.json()).resolves.toEqual({ wrappers: [{ salt: "current" }] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each(["userId=user-1", "userId=user-1&fresh=1"])(
    "starts a forced read independently of pending %s and rejects its late cache write",
    async (firstQuery) => {
      const old = deferredResponse();
      const fresh = deferredResponse();
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
      const initial = route.GET(request(firstQuery));
      const duplicate = route.GET(request("userId=user-1"));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const forced = route.GET(request("userId=user-1&fresh=1"));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      fresh.resolve(Response.json({ wrappers: [{ salt: "current" }] }));
      await expect((await forced).json()).resolves.toEqual({ wrappers: [{ salt: "current" }] });
      old.resolve(Response.json({ wrappers: [{ salt: "retired" }] }));
      await Promise.all([initial, duplicate]);
      const cached = await route.GET(request("userId=user-1"));
      await expect(cached.json()).resolves.toEqual({ wrappers: [{ salt: "current" }] });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    },
  );

  it("does not fall back to stale wrappers when a forced read fails", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ wrappers: [{ salt: "cached" }] }))
      .mockRejectedValueOnce(new Error("synthetic offline"));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await route.GET(request("userId=user-1"));
    clock.mockReturnValue(now + 61_000);
    const response = await route.GET(request("userId=user-1&fresh=1"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Vault is temporarily unavailable", code: "VAULT_TEMPORARILY_UNAVAILABLE",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves ordinary error fallback when another read has populated current metadata", async () => {
    const old = deferredResponse();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(Response.json({ wrappers: [{ salt: "current" }] }));
    const ordinary = route.GET(request("userId=user-1"));
    await route.GET(request("userId=user-1&fresh=1"));
    old.reject(new Error("synthetic offline"));
    const response = await ordinary;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ wrappers: [{ salt: "current" }], degraded: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not share another owner's or bearer's cached metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ wrappers: [] }));
    await route.GET(request("userId=user-1"));
    await route.GET(request("userId=user-2"));
    await route.GET(request("userId=user-1", "Bearer other-token"));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("serves a warm cache on an ordinary read", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ primaryMethod: "passphrase", wrappers: [] }));

    await route.GET(request("userId=user-1"));
    await route.GET(request("userId=user-1"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("bypasses the warm cache and hits the backend again when fresh=1 is set", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ primaryMethod: "passphrase", wrappers: [] }))
      .mockResolvedValueOnce(Response.json({ primaryMethod: "passphrase", wrappers: [] }));

    await route.GET(request("userId=user-1"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const freshResponse = await route.GET(request("userId=user-1&fresh=1"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(freshResponse.json()).resolves.toMatchObject({ primaryMethod: "passphrase" });
  });

  it("writes a fresh entry back into the cache so later ordinary reads see it", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ primaryMethod: "passphrase", wrappers: [] }))
      .mockResolvedValueOnce(Response.json({ primaryMethod: "generated_default_native_biometric", wrappers: [] }));

    await route.GET(request("userId=user-1"));
    await route.GET(request("userId=user-1&fresh=1"));
    const cached = await route.GET(request("userId=user-1"));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await expect(cached.json()).resolves.toMatchObject({
      primaryMethod: "generated_default_native_biometric",
    });
  });
});

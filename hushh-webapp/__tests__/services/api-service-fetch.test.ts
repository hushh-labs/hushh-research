import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capacitorMocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
  getPlatform: vi.fn(() => "web"),
  request: vi.fn(),
}));

const kaiMocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  streamPortfolioImport: vi.fn(),
  streamPortfolioImportRun: vi.fn(),
  streamPortfolioAnalyzeLosers: vi.fn(),
  streamKaiAnalysis: vi.fn(),
  cancelKaiAnalysisStream: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks – declared before any import that touches them
// ---------------------------------------------------------------------------

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: capacitorMocks.isNativePlatform,
    getPlatform: capacitorMocks.getPlatform,
  },
  CapacitorHttp: { request: capacitorMocks.request },
}));

vi.mock("@/lib/capacitor", () => ({
  HushhVault: {},
  HushhAuth: {},
  HushhConsent: {},
  HushhNotifications: {},
}));

vi.mock("@/lib/capacitor/kai", () => ({
  Kai: kaiMocks,
  PORTFOLIO_STREAM_EVENT: "portfolio_stream",
  KAI_STREAM_EVENT: "kai_stream",
}));

vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getIdToken: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

vi.mock("@/lib/observability/client", () => ({
  toDurationBucket: () => "fast",
  trackApiRequestCompleted: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/observability/route-map", () => ({
  resolveRouteId: () => "test-route",
}));

vi.mock("@/lib/motion/api-progress-tracker", () => ({
  trackRequestStart: vi.fn(),
  trackRequestEnd: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { ApiService } from "@/lib/services/api-service";
import { AuthService } from "@/lib/services/auth-service";
import { REQUEST_TIMESTAMP_HEADER } from "@/lib/observability/request-id";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeUnsignedToken(payload: Record<string, unknown>): string {
  const payloadBase64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `header.${payloadBase64}.sig`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiService.apiFetch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    capacitorMocks.getPlatform.mockReturnValue("web");
    capacitorMocks.request.mockReset();
    vi.mocked(AuthService.getIdToken).mockReset();
    vi.mocked(AuthService.getCurrentUser).mockReset();
    for (const mock of Object.values(kaiMocks)) mock.mockReset();
    kaiMocks.addListener.mockResolvedValue({ remove: vi.fn() });
    kaiMocks.cancelKaiAnalysisStream.mockResolvedValue({ cancelled: true });
    publishValidatedAuthSessionOwner(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1 – Web platform: calls fetch with relative path (no base URL)
  it("calls fetch with a relative path on web (no base URL prepended)", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await ApiService.apiFetch("/api/test", {
      method: "GET",
      headers: { Authorization: "Bearer firebase-token-abc" },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    // On web the URL should be the path itself (relative), no hostname prefix
    expect(calledUrl).toBe("/api/test");
  });

  // 2 – Every request includes X-Request-Id header
  it("checks account session status with the caller's cached Firebase token", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ active: true }));

    const response = await ApiService.getAccountSessionStatus("cached-token");

    expect(response.status).toBe(200);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("/api/account/session-status");
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer cached-token",
    );
    expect((options.headers as Record<string, string>)["Cache-Control"]).toBe(
      "no-store",
    );
    expect(options.cache).toBe("no-store");
  });

  it("includes an x-request-id header in every request", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await ApiService.apiFetch("/api/ping", {
      method: "GET",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers).toHaveProperty("x-request-id");
    expect(headers["x-request-id"]).toBeTruthy();
  });

  // 3 – 401 response triggers Firebase token refresh + retry
  it("normalizes future-dated request timestamp headers before fetch", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_716_500_000_000);

    await ApiService.apiFetch("/api/ping", {
      method: "GET",
      headers: {
        [REQUEST_TIMESTAMP_HEADER]: String(1_716_500_000_000 + 60_001),
      },
    });

    const [, fetchOptions] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = fetchOptions.headers as Record<string, string>;
    expect(headers[REQUEST_TIMESTAMP_HEADER]).toBe("1716500000000");

    nowSpy.mockRestore();
  });

  it.each(["user_id", "sub"])(
    "replays the same body when refreshed %s still identifies the same account",
    async (claim) => {
      const originalToken = makeUnsignedToken({
        [claim]: "user-1",
        version: 1,
      });
      const freshToken = makeUnsignedToken({ [claim]: "user-1", version: 2 });
      (
        AuthService.getIdToken as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(freshToken);
      (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
        uid: "user-1",
      } as never);

      // First call → 401, second call (retry) → 200
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "Unauthorized" }, 401))
        .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

      const body = JSON.stringify({ lookups: [{ lookup_id: "opaque" }] });
      const response = await ApiService.apiFetch(
        "/api/one/connections/contact-sync",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${originalToken}` },
          body,
        },
      );

      // Should have called getIdToken with force=true
      expect(AuthService.getIdToken).toHaveBeenCalledWith(true);

      // fetch was called twice: original + retry
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // The retry call should carry the fresh token and the retry header
      const [, retryOptions] = mockFetch.mock.calls[1] as [string, RequestInit];
      const retryHeaders = retryOptions.headers as Record<string, string>;
      expect(retryHeaders["Authorization"]).toBe(`Bearer ${freshToken}`);
      expect(retryHeaders["X-Hushh-Auth-Refresh-Retry"]).toBe("1");
      expect(retryOptions.method).toBe("POST");
      expect(retryOptions.body).toBe(body);

      // Final response should be the 200
      expect(response.status).toBe(200);
    },
  );

  it.each(["account-a", "account-b"])(
    "does not replay or invalidate the replacement session when refresh resolves for %s after an account switch",
    async (refreshedAccount) => {
      const accountAToken = makeUnsignedToken({ user_id: "account-a" });
      let finishRefresh!: (token: string) => void;
      vi.mocked(AuthService.getIdToken).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue({
        uid: "account-a",
      } as never);
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Unauthorized" }, 401),
      );

      const pendingResponse = ApiService.apiFetch(
        "/api/one/connections/contact-sync",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accountAToken}` },
          body: JSON.stringify({ lookups: [{ lookup_id: "opaque" }] }),
        },
      );

      await vi.waitFor(() =>
        expect(AuthService.getIdToken).toHaveBeenCalledWith(true),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue({
        uid: "account-b",
      } as never);
      finishRefresh(
        makeUnsignedToken({ user_id: refreshedAccount, version: 2 }),
      );
      const response = await pendingResponse;

      expect(response.status).toBe(401);
      expect(AuthService.getIdToken).toHaveBeenCalledWith(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(
        dispatchSpy.mock.calls.filter(
          ([event]) =>
            event instanceof CustomEvent &&
            event.type === "auth-session-invalidated",
        ),
      ).toHaveLength(0);
    },
  );
  it.each(["account-a", "account-b"])(
    "does not replay a native refresh after the owner generation changes to %s",
    async (nextUserId) => {
      capacitorMocks.isNativePlatform.mockReturnValue(true);
      vi.mocked(AuthService.getCurrentUser).mockReturnValue(null);
      publishValidatedAuthSessionOwner("account-a");
      let finishRefresh!: (token: string) => void;
      vi.mocked(AuthService.getIdToken).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve;
          }),
      );
      capacitorMocks.request.mockResolvedValueOnce({
        status: 401,
        headers: {},
        data: { error: "Unauthorized" },
      });
      const dispatch = vi.spyOn(window, "dispatchEvent");
      const pending = ApiService.apiFetch("https://uat.example/api/protected", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${makeUnsignedToken({ user_id: "account-a" })}`,
        },
        body: "owner-a-body",
      });
      await vi.waitFor(() =>
        expect(AuthService.getIdToken).toHaveBeenCalledWith(true),
      );
      publishValidatedAuthSessionOwner(null);
      publishValidatedAuthSessionOwner(nextUserId);
      finishRefresh(makeUnsignedToken({ user_id: nextUserId, version: 2 }));
      expect((await pending).status).toBe(401);
      expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
      expect(
        dispatch.mock.calls.filter(
          ([event]) => event.type === "auth-session-invalidated",
        ),
      ).toHaveLength(0);
    },
  );

  it("retries native Firebase requests with a forced fresh token on 401", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    const staleToken = makeUnsignedToken({ user_id: "native-user", iat: 1 });
    const freshToken = makeUnsignedToken({ user_id: "native-user", iat: 2 });
    vi.mocked(AuthService.getCurrentUser).mockReturnValue(null);
    publishValidatedAuthSessionOwner("native-user");
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      freshToken,
    );
    capacitorMocks.request
      .mockResolvedValueOnce({
        status: 401,
        headers: { "content-type": "application/json" },
        data: { detail: "Invalid Firebase ID token" },
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "application/json" },
        data: { ok: true },
      });

    try {
      const response = await ApiService.apiFetch("/db/vault/bootstrap-state", {
        method: "POST",
        headers: { Authorization: `Bearer ${staleToken}` },
      });

      expect(response.status).toBe(200);
      expect(AuthService.getIdToken).toHaveBeenCalledWith(true);
      expect(capacitorMocks.request).toHaveBeenCalledTimes(2);
      expect(capacitorMocks.request.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${freshToken}`,
            "X-Hushh-Auth-Refresh-Retry": "1",
          }),
        }),
      );
    } finally {
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("dispatches account-not-found immediately for native deleted-account responses", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    capacitorMocks.request.mockResolvedValueOnce({
      status: 401,
      headers: { "content-type": "application/json" },
      data: {
        detail: {
          code: "AUTH_ACCOUNT_NOT_FOUND",
          message: "Account not found",
        },
      },
    });
    const details: unknown[] = [];
    const handleInvalidation = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", handleInvalidation);
    const deletedToken = makeUnsignedToken({ user_id: "deleted-user" });

    try {
      const response = await ApiService.apiFetch("/db/vault/bootstrap-state", {
        method: "POST",
        headers: { Authorization: `Bearer ${deletedToken}` },
      });

      expect(response.status).toBe(401);
      expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
      expect(details).toEqual([
        {
          code: "account_not_found",
          path: "/db/vault/bootstrap-state",
          userId: "deleted-user",
        },
      ]);
    } finally {
      window.removeEventListener(
        "auth-session-invalidated",
        handleInvalidation,
      );
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("dispatches the same account-not-found transition for web responses", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            detail: { code: "AUTH_ACCOUNT_NOT_FOUND" },
          },
        },
        401,
      ),
    );
    const details: unknown[] = [];
    const handleInvalidation = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", handleInvalidation);
    const deletedToken = makeUnsignedToken({ user_id: "deleted-user" });

    try {
      const response = await ApiService.apiFetch("/api/vault/bootstrap-state", {
        method: "POST",
        headers: { Authorization: `Bearer ${deletedToken}` },
      });

      expect(response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
      expect(details).toEqual([
        {
          code: "account_not_found",
          path: "/api/vault/bootstrap-state",
          userId: "deleted-user",
        },
      ]);
    } finally {
      window.removeEventListener(
        "auth-session-invalidated",
        handleInvalidation,
      );
    }
  });

  it("scopes a terminal web HCT response to the validated session owner", async () => {
    publishValidatedAuthSessionOwner("deleted-hct-user");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, 401),
    );
    const details: unknown[] = [];
    const handleInvalidation = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", handleInvalidation);

    try {
      const response = await ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:deleted-owner-token" },
      });

      expect(response.status).toBe(401);
      expect(details).toEqual([
        {
          code: "account_not_found",
          path: "/api/one/location/state",
          userId: "deleted-hct-user",
        },
      ]);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        "auth-session-invalidated",
        handleInvalidation,
      );
    }
  });

  it("scopes a terminal native HCT response to the validated session owner", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    publishValidatedAuthSessionOwner("native-deleted-hct-user");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 401,
      headers: { "content-type": "application/json" },
      data: { detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } },
      url: "https://uat.example/api/one/location/state",
    });
    const details: unknown[] = [];
    const handleInvalidation = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", handleInvalidation);

    try {
      const response = await ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:deleted-owner-token" },
      });

      expect(response.status).toBe(401);
      expect(details).toEqual([
        {
          code: "account_not_found",
          path: "/api/one/location/state",
          userId: "native-deleted-hct-user",
        },
      ]);
      expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        "auth-session-invalidated",
        handleInvalidation,
      );
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("classifies account-not-found from the native FormData fallback", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("android");
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    publishValidatedAuthSessionOwner("native-upload-owner");
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, 401),
    );
    const details: unknown[] = [];
    const handleInvalidation = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", handleInvalidation);

    try {
      const formData = new FormData();
      formData.append("file", new Blob(["test"]), "test.txt");
      const response = await ApiService.apiFetch("/api/import/upload", {
        method: "POST",
        headers: { Authorization: "Bearer HCT:native-upload-token" },
        body: formData,
      });

      expect(response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capacitorMocks.request).not.toHaveBeenCalled();
      expect(details).toEqual([
        {
          code: "account_not_found",
          path: "/api/import/upload",
          userId: "native-upload-owner",
        },
      ]);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        "auth-session-invalidated",
        handleInvalidation,
      );
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("ignores a delayed web HCT terminal response after account A switches to B", async () => {
    const pendingResponse = deferred<Response>();
    publishValidatedAuthSessionOwner("account-a");
    mockFetch.mockReturnValueOnce(pendingResponse.promise);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    try {
      const request = ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:account-a-token" },
      });
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      publishValidatedAuthSessionOwner("account-b");
      pendingResponse.resolve(
        jsonResponse({ detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } }, 401),
      );

      expect((await request).status).toBe(401);
      const invalidations = dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent &&
          event.type === "auth-session-invalidated",
      );
      expect(invalidations).toHaveLength(0);
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it("ignores a delayed native HCT terminal response after account A switches to B", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    const pendingResponse = deferred<{
      status: number;
      headers: Record<string, string>;
      data: unknown;
      url: string;
    }>();
    publishValidatedAuthSessionOwner("account-a");
    capacitorMocks.request.mockReturnValueOnce(pendingResponse.promise);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    try {
      const request = ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:account-a-token" },
      });
      await vi.waitFor(() =>
        expect(capacitorMocks.request).toHaveBeenCalledTimes(1),
      );
      publishValidatedAuthSessionOwner("account-b");
      pendingResponse.resolve({
        status: 401,
        headers: { "content-type": "application/json" },
        data: { detail: { code: "AUTH_ACCOUNT_NOT_FOUND" } },
        url: "https://uat.example/api/one/location/state",
      });

      expect((await request).status).toBe(401);
      const invalidations = dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent &&
          event.type === "auth-session-invalidated",
      );
      expect(invalidations).toHaveLength(0);
    } finally {
      dispatchSpy.mockRestore();
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  // 4 – Handle unchanged token safely and keep session when user is same
  it.each([
    ["the unchanged initiating token", "unchanged"],
    ["no token", "missing"],
    ["a rejection", "rejected"],
  ])(
    "does not invalidate the replacement session when a stale refresh returns %s",
    async (_label, refreshOutcome) => {
      const accountAToken = makeUnsignedToken({ user_id: "account-a" });
      const accountA = { uid: "account-a" };
      const accountB = { uid: "account-b" };
      let finishRefresh!: (value: string | null) => void;
      let rejectRefresh!: (reason: Error) => void;
      vi.mocked(AuthService.getIdToken).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishRefresh = resolve;
            rejectRefresh = reject;
          }),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue(accountA as never);
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Unauthorized" }, 401),
      );

      const pendingResponse = ApiService.apiFetch(
        "/api/one/connections/contact-sync",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accountAToken}` },
          body: JSON.stringify({ lookups: [{ lookup_id: "opaque" }] }),
        },
      );

      await vi.waitFor(() =>
        expect(AuthService.getIdToken).toHaveBeenCalledWith(true),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue(accountB as never);
      if (refreshOutcome === "rejected") {
        rejectRefresh(new Error("stale refresh failed"));
      } else {
        finishRefresh(refreshOutcome === "unchanged" ? accountAToken : null);
      }
      const response = await pendingResponse;

      expect(response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(
        dispatchSpy.mock.calls.filter(
          ([event]) =>
            event instanceof CustomEvent &&
            event.type === "auth-session-invalidated",
        ),
      ).toHaveLength(0);
    },
  );

  it.each([
    ["auth/user-token-expired", 1],
    ["auth/network-request-failed", 0],
    ["unknown", 0],
  ])(
    "only invalidates an initiating session for a terminal refresh error: %s",
    async (code, invalidations) => {
      const accountAToken = makeUnsignedToken({ user_id: "account-a" });
      const accountA = { uid: "account-a" };
      vi.mocked(AuthService.getIdToken).mockRejectedValueOnce(
        Object.assign(new Error("refresh failed"), { code }),
      );
      vi.mocked(AuthService.getCurrentUser).mockReturnValue(accountA as never);
      const dispatchSpy = vi.spyOn(window, "dispatchEvent");
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: "Unauthorized" }, 401),
      );

      const response = await ApiService.apiFetch("/api/protected", {
        method: "GET",
        headers: { Authorization: `Bearer ${accountAToken}` },
      });

      expect(response.status).toBe(401);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(
        dispatchSpy.mock.calls.filter(
          ([event]) =>
            event instanceof CustomEvent &&
            event.type === "auth-session-invalidated",
        ),
      ).toHaveLength(invalidations);
    },
  );

  it("does not dispatch auth-session-invalidated when refresh yields same token for active account", async () => {
    const staleToken = makeUnsignedToken({ user_id: "user-1" });
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      staleToken,
    );
    (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
      uid: "user-1",
    } as never);

    mockFetch.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: `Bearer ${staleToken}` },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const invalidatedEvents = dispatchSpy.mock.calls.filter(
      ([event]) =>
        event instanceof CustomEvent &&
        event.type === "auth-session-invalidated",
    );
    expect(invalidatedEvents.length).toBe(0);
    expect(response.status).toBe(401);

    dispatchSpy.mockRestore();
  });

  it("does not refresh or invalidate the current account for another account's bearer", async () => {
    const staleToken = makeUnsignedToken({ user_id: "user-2" });
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValue(
      staleToken,
    );
    (AuthService.getCurrentUser as ReturnType<typeof vi.fn>).mockReturnValue({
      uid: "user-1",
    } as never);

    mockFetch.mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401));

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    const response = await ApiService.apiFetch("/api/protected", {
      method: "GET",
      headers: { Authorization: `Bearer ${staleToken}` },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);

    const invalidatedEvents = dispatchSpy.mock.calls.filter(
      ([event]) =>
        event instanceof CustomEvent &&
        event.type === "auth-session-invalidated",
    );
    expect(invalidatedEvents).toHaveLength(0);
    expect(AuthService.getIdToken).not.toHaveBeenCalled();
    expect(response.status).toBe(401);

    dispatchSpy.mockRestore();
  });

  it("does not refresh or invalidate a replacement session when the original 401 arrives after switching accounts", async () => {
    const accountAToken = makeUnsignedToken({ user_id: "account-a" });
    vi.mocked(AuthService.getCurrentUser).mockReturnValue({
      uid: "account-a",
    } as never);
    let finishRequest!: (response: Response) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishRequest = resolve;
        }),
    );
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    const pending = ApiService.apiFetch("/api/one/connections/contact-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${accountAToken}` },
      body: JSON.stringify({ lookups: [{ lookup_id: "opaque" }] }),
    });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    vi.mocked(AuthService.getCurrentUser).mockReturnValue({
      uid: "account-b",
    } as never);
    finishRequest(jsonResponse({ error: "Unauthorized" }, 401));

    expect((await pending).status).toBe(401);
    expect(AuthService.getIdToken).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent &&
          event.type === "auth-session-invalidated",
      ),
    ).toHaveLength(0);
  });

  // 5 – Successful response returns Response object
  it("returns the Response object on success", async () => {
    const payload = { message: "hello" };
    mockFetch.mockResolvedValueOnce(jsonResponse(payload, 200));

    const response = await ApiService.apiFetch("/api/data", {
      method: "GET",
      headers: { Authorization: "Bearer valid-token" },
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(payload);
  });

  it("requests a vault lock when web rejects an HCT token after validation", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ detail: "Token validation failed." }, 401),
    );
    const lockReasons: string[] = [];
    const handleLock = (event: Event) => {
      lockReasons.push(
        String(
          (event as CustomEvent<{ reason?: string }>).detail?.reason || "",
        ),
      );
    };
    window.addEventListener("vault-lock-requested", handleLock);

    try {
      const response = await ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:expired-vault-owner" },
      });

      expect(response.status).toBe(401);
      expect(lockReasons).toEqual(["Token validation failed."]);
      expect(AuthService.getIdToken).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("vault-lock-requested", handleLock);
    }
  });

  it("requests the same vault lock when native rejects an HCT token", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 401,
      headers: { "content-type": "application/json" },
      data: { detail: "Token validation failed." },
      url: "https://uat.example/api/one/location/state",
    });
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://uat.example";
    const lockReasons: string[] = [];
    const handleLock = (event: Event) => {
      lockReasons.push(
        String(
          (event as CustomEvent<{ reason?: string }>).detail?.reason || "",
        ),
      );
    };
    window.addEventListener("vault-lock-requested", handleLock);

    try {
      const response = await ApiService.apiFetch("/api/one/location/state", {
        headers: { Authorization: "Bearer HCT:expired-vault-owner" },
      });

      expect(response.status).toBe(401);
      expect(lockReasons).toEqual(["Token validation failed."]);
      expect(capacitorMocks.request).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("vault-lock-requested", handleLock);
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("dispatches account-not-found when a native Kai stream rejects with the exact lifecycle code", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    publishValidatedAuthSessionOwner("deleted-stream-owner");
    kaiMocks.streamKaiAnalysis.mockRejectedValueOnce(
      Object.assign(new Error("Stream request was rejected."), {
        code: "AUTH_ACCOUNT_NOT_FOUND",
      }),
    );
    const details: unknown[] = [];
    const handleInvalidation = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener("auth-session-invalidated", handleInvalidation);

    try {
      const response = await ApiService.streamKaiAnalysis({
        userId: "deleted-stream-owner",
        ticker: "AAPL",
        riskProfile: "balanced",
        vaultOwnerToken: "HCT:deleted-owner-token",
      });

      await expect(response.text()).rejects.toThrow(
        "Stream request was rejected.",
      );
      expect(details).toEqual([
        {
          code: "account_not_found",
          path: "/api/kai/analyze/stream",
          userId: "deleted-stream-owner",
        },
      ]);
    } finally {
      window.removeEventListener(
        "auth-session-invalidated",
        handleInvalidation,
      );
    }
  });

  it.each([
    "AUTH_VAULT_OWNER_INVALID",
    "AUTH_ACCOUNT_DELETION_IN_PROGRESS",
    "AUTH_ACCOUNT_STATUS_UNAVAILABLE",
  ])(
    "locks the Vault without claiming deletion for native stream code %s",
    async (bridgeCode) => {
      capacitorMocks.isNativePlatform.mockReturnValue(true);
      publishValidatedAuthSessionOwner("stream-owner");
      kaiMocks.streamKaiAnalysis.mockRejectedValueOnce(
        Object.assign(new Error("Stream request was rejected."), {
          code: bridgeCode,
        }),
      );
      const lockDetails: unknown[] = [];
      const handleLock = (event: Event) => {
        lockDetails.push((event as CustomEvent).detail);
      };
      const invalidationSpy = vi.fn();
      window.addEventListener("vault-lock-requested", handleLock);
      window.addEventListener("auth-session-invalidated", invalidationSpy);

      try {
        const response = await ApiService.streamKaiAnalysis({
          userId: "stream-owner",
          ticker: "AAPL",
          riskProfile: "balanced",
          vaultOwnerToken: "HCT:expired-owner-token",
        });

        await expect(response.text()).rejects.toThrow(
          "Stream request was rejected.",
        );
        expect(lockDetails).toEqual([
          {
            reason: bridgeCode,
            path: "/api/kai/analyze/stream",
          },
        ]);
        expect(invalidationSpy).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener("vault-lock-requested", handleLock);
        window.removeEventListener("auth-session-invalidated", invalidationSpy);
      }
    },
  );

  it("ignores a delayed native stream auth failure after Account A switches to B", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    publishValidatedAuthSessionOwner("account-a");
    const pendingStream = deferred<Record<string, unknown>>();
    kaiMocks.streamKaiAnalysis.mockReturnValueOnce(pendingStream.promise);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");

    try {
      const response = await ApiService.streamKaiAnalysis({
        userId: "account-a",
        ticker: "AAPL",
        riskProfile: "balanced",
        vaultOwnerToken: "HCT:account-a-token",
      });
      const consumption = response.text();
      await vi.waitFor(() =>
        expect(kaiMocks.streamKaiAnalysis).toHaveBeenCalledTimes(1),
      );

      publishValidatedAuthSessionOwner("account-b");
      pendingStream.reject(
        Object.assign(new Error("Stream request was rejected."), {
          code: "AUTH_ACCOUNT_NOT_FOUND",
        }),
      );

      await expect(consumption).rejects.toThrow("Stream request was rejected.");
      const authSideEffects = dispatchSpy.mock.calls.filter(
        ([event]) =>
          event instanceof CustomEvent &&
          (event.type === "auth-session-invalidated" ||
            event.type === "vault-lock-requested"),
      );
      expect(authSideEffects).toHaveLength(0);
    } finally {
      dispatchSpy.mockRestore();
    }
  });

  it("uses IPv4 loopback for local iOS simulator backend requests", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
      url: "http://127.0.0.1:8000/health",
    });
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "http://localhost:8000";

    try {
      const response = await ApiService.apiFetch("/health");

      expect(response.status).toBe(200);
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://127.0.0.1:8000/health" }),
      );
    } finally {
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
    }
  });

  it("sends native Plaid status requests to the configured backend URL", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(true);
    capacitorMocks.getPlatform.mockReturnValue("ios");
    capacitorMocks.request.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { ok: true },
      url: "https://api.hushh.ai/api/kai/plaid/status/user-123",
    });
    const previousBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    const previousServerBackendUrl = process.env.BACKEND_URL;
    delete process.env.BACKEND_URL;
    process.env.NEXT_PUBLIC_BACKEND_URL = "https://api.hushh.ai";

    try {
      const response = await ApiService.apiFetch(
        "/api/kai/plaid/status/user-123",
        {
          headers: { Authorization: "Bearer HCT:vault-owner-token" },
        },
      );

      expect(response.status).toBe(200);
      expect(capacitorMocks.request).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://api.hushh.ai/api/kai/plaid/status/user-123",
        }),
      );
    } finally {
      if (previousBackendUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BACKEND_URL;
      } else {
        process.env.NEXT_PUBLIC_BACKEND_URL = previousBackendUrl;
      }
      if (previousServerBackendUrl === undefined) {
        delete process.env.BACKEND_URL;
      } else {
        process.env.BACKEND_URL = previousServerBackendUrl;
      }
    }
  });

  it("fetches baseline market insights with Firebase auth", async () => {
    (AuthService.getIdToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "firebase-id-token",
    );
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        generated_at: "2026-03-30T00:00:00Z",
        meta: { market_mode: "baseline" },
      }),
    );

    const payload = await ApiService.getKaiMarketBaselineInsights({
      userId: "user_123",
      daysBack: 7,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      "/api/kai/market/insights/baseline/user_123?days_back=7",
    );
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer firebase-id-token",
    );
    expect(payload.meta?.market_mode).toBe("baseline");
  });

  it("starts UAT phone test verification through the account proxy", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        eligible: true,
        verification_id: "uat-test-phone:abc123",
      }),
    );

    const payload = await ApiService.startUatPhoneTestVerification(
      "+16505550101",
      "firebase-id-token",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("/api/account/phone/uat-test/start");
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer firebase-id-token",
    );
    expect(JSON.parse(String(options.body))).toEqual({
      phone_number: "+16505550101",
    });
    expect(payload).toEqual({
      success: true,
      eligible: true,
      verification_id: "uat-test-phone:abc123",
      reason: undefined,
    });
  });

  it("confirms UAT phone test verification without a Firebase phone token", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        user_id: "user_123",
        phone_verified: true,
        identity: {
          user_id: "user_123",
          phone_number: "+16505550101",
          phone_verified: true,
          source: "uat_test_phone_claim",
        },
      }),
    );

    const payload = await ApiService.confirmUatPhoneTestVerification(
      "+16505550101",
      "000000",
      "uat-test-phone:abc123",
      "firebase-id-token",
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, options] = mockFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("/api/account/phone/uat-test/confirm");
    expect((options.headers as Record<string, string>).Authorization).toBe(
      "Bearer firebase-id-token",
    );
    expect(JSON.parse(String(options.body))).toEqual({
      phone_number: "+16505550101",
      verification_code: "000000",
      verification_id: "uat-test-phone:abc123",
    });
    expect(payload.phone_verified).toBe(true);
    expect(payload.identity?.source).toBe("uat_test_phone_claim");
  });
});


describe("voice relay authentication downgrade boundary", () => {
  it("shows the private voice refusal without reflecting provider details", async () => {
    publishValidatedAuthSessionOwner("owner-a");
    vi.mocked(AuthService.getIdToken).mockResolvedValue(makeUnsignedToken({ sub: "owner-a" }));
    vi.spyOn(ApiService, "apiFetch").mockResolvedValue(jsonResponse({ detail: {
      code: "AGENT_NOT_READY", status: "unavailable", message: "synthetic-private-detail",
    } }, 503));
    await expect(ApiService.createOneAdkRelaySession({ requireAuthenticated: true })).rejects.toMatchObject({
      status: 503, code: "AGENT_NOT_READY",
      message: "Private-agent voice is unavailable. Use your private agent's typed chat.",
    });
  });

  beforeEach(() => { vi.clearAllMocks(); publishValidatedAuthSessionOwner("synthetic-owner"); });
  afterEach(() => { vi.restoreAllMocks(); publishValidatedAuthSessionOwner(null); });

  it.each([false, true])("refuses a missing signed-in token before relay fetch (native=%s)", async (native) => {
    capacitorMocks.isNativePlatform.mockReturnValue(native);
    vi.mocked(AuthService.getCurrentUser).mockReturnValue(null);
    vi.mocked(AuthService.getIdToken).mockResolvedValue(null);
    const relayFetch = vi.spyOn(ApiService, "apiFetch");
    await expect(ApiService.createOneAdkRelaySession({ requireAuthenticated: true })).rejects.toMatchObject({ status: 401 });
    expect(AuthService.getIdToken).toHaveBeenCalledWith(true);
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("refuses a known browser owner's token failure without disclosing provider text", async () => {
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    vi.mocked(AuthService.getCurrentUser).mockReturnValue({ uid: "synthetic-owner" } as never);
    vi.mocked(AuthService.getIdToken).mockRejectedValue(new Error("synthetic-private-provider-error"));
    const relayFetch = vi.spyOn(ApiService, "apiFetch");
    await expect(ApiService.createOneAdkRelaySession()).rejects.toMatchObject({ status: 503, code: "AUTH_PROVIDER_UNAVAILABLE" });
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("preserves explicit anonymous voice when no user or token exists", async () => {
    publishValidatedAuthSessionOwner(null);
    capacitorMocks.isNativePlatform.mockReturnValue(false);
    vi.mocked(AuthService.getCurrentUser).mockReturnValue(null);
    vi.mocked(AuthService.getIdToken).mockResolvedValue(null);
    const relayFetch = vi.spyOn(ApiService, "apiFetch").mockResolvedValue(jsonResponse({ tier: "intro" }));
    await expect(ApiService.createOneAdkRelaySession()).resolves.toEqual({ tier: "intro" });
    expect(relayFetch.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
  });
  it("rejects delayed token resolution after an account switch before any relay request", async () => {
    const token = deferred<string>();
    vi.mocked(AuthService.getIdToken).mockReturnValue(token.promise);
    const relayFetch = vi.spyOn(ApiService, "apiFetch");
    const request = ApiService.createOneAdkRelaySession({ requireAuthenticated: true });
    publishValidatedAuthSessionOwner("replacement-owner");
    token.resolve(makeUnsignedToken({ sub: "synthetic-owner" }));
    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("keeps terminal credential failures as 401 rather than provider outages", async () => {
    vi.mocked(AuthService.getIdToken).mockRejectedValue({ code: "auth/user-disabled", message: "synthetic-private-error" });
    const relayFetch = vi.spyOn(ApiService, "apiFetch");
    await expect(ApiService.createOneAdkRelaySession({ requireAuthenticated: true })).rejects.toMatchObject({ status: 401 });
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("rejects a relay response that arrives after owner replacement", async () => {
    vi.mocked(AuthService.getIdToken).mockResolvedValue(makeUnsignedToken({ sub: "synthetic-owner" }));
    const response = deferred<Response>();
    const relayFetch = vi.spyOn(ApiService, "apiFetch").mockReturnValue(response.promise);
    const request = ApiService.createOneAdkRelaySession({ requireAuthenticated: true });
    await vi.waitFor(() => expect(relayFetch).toHaveBeenCalledOnce());
    publishValidatedAuthSessionOwner("replacement-owner");
    response.resolve(jsonResponse({ relay_ticket: "synthetic-ticket" }));
    await expect(request).rejects.toMatchObject({ status: 401 });
  });

});

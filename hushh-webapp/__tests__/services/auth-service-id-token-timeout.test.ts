/**
 * A stalled Firebase token refresh must resolve to "no token", never hang.
 *
 * `apiFetch` asks `AuthService.getIdToken()` for a bearer BEFORE any request
 * leaves the browser. While the cached token is valid that returns instantly;
 * once it has expired -- a person coming back to an open tab after an hour away
 * -- the SDK refreshes it over the network, and that call has no timeout of its
 * own. Seen 2026-09-02 on localhost: the refresh stalled, every API call in the
 * tab waited on it, nothing reached the proxy or the backend, and the cloud step
 * read "Checking your cloud..." indefinitely.
 *
 * These tests pin the ceiling: past it the getter yields null so the caller
 * reaches its own error path (a 401, a retry, a bounded screen).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = { getIdToken: vi.fn() };

vi.mock("@/lib/firebase/config", () => ({
  auth: {
    get currentUser() {
      return currentUser;
    },
  },
}));

vi.mock("@capacitor/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@capacitor/core")>()),
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));

describe("AuthService.getIdToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    currentUser.getIdToken.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the token when the refresh answers in time", async () => {
    currentUser.getIdToken.mockResolvedValue("id-token");
    const { AuthService } = await import("@/lib/services/auth-service");
    await expect(AuthService.getIdToken()).resolves.toBe("id-token");
  });

  it("gives up on a refresh that never answers, instead of hanging every caller", async () => {
    currentUser.getIdToken.mockReturnValue(new Promise(() => {})); // never settles
    const { AuthService, ID_TOKEN_TIMEOUT_MS } = await import(
      "@/lib/services/auth-service"
    );
    const pending = AuthService.getIdToken();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(ID_TOKEN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toBeNull();
  });

  it("still surfaces a refresh that fails outright as no token", async () => {
    currentUser.getIdToken.mockRejectedValue(new Error("auth/network-request-failed"));
    const { AuthService } = await import("@/lib/services/auth-service");
    await expect(AuthService.getIdToken()).resolves.toBeNull();
  });
});

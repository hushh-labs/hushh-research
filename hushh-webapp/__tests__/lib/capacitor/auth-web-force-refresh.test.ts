import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    currentUser: null as {
      getIdToken: (forceRefresh?: boolean) => Promise<string>;
    } | null,
  },
}));

vi.mock("@/lib/firebase/config", () => ({ auth: mocks.auth }));

vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: class GoogleAuthProvider {
    setCustomParameters() {}
  },
  OAuthProvider: class OAuthProvider {
    addScope() {}
  },
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
}));

import { HushhAuthWeb } from "@/lib/capacitor/plugins/auth-web";

describe("HushhAuthWeb forced token refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.currentUser = null;
  });

  it("does not return its cached token when no live Firebase user exists", async () => {
    const bridge = new HushhAuthWeb();
    (
      bridge as unknown as {
        currentIdToken: string | null;
      }
    ).currentIdToken = "cached-token";

    await expect(bridge.getIdToken({ forceRefresh: true })).rejects.toMatchObject({
      name: "HushhAuthError",
      code: "auth/invalid-user-token",
    });
  });

  it("propagates a forced Firebase refresh failure instead of using cache", async () => {
    const refreshError = Object.assign(new Error("User was deleted"), {
      code: "auth/user-not-found",
    });
    const getIdToken = vi.fn().mockRejectedValue(refreshError);
    mocks.auth.currentUser = { getIdToken };
    const bridge = new HushhAuthWeb();
    (
      bridge as unknown as {
        currentIdToken: string | null;
      }
    ).currentIdToken = "cached-token";

    await expect(
      bridge.getIdToken({ forceRefresh: true }),
    ).rejects.toBe(refreshError);
    expect(getIdToken).toHaveBeenCalledWith(true);
  });

  it("retains the cached fallback for a normal offline token read", async () => {
    const getIdToken = vi.fn().mockRejectedValue(new Error("offline"));
    mocks.auth.currentUser = { getIdToken };
    const bridge = new HushhAuthWeb();
    (
      bridge as unknown as {
        currentIdToken: string | null;
      }
    ).currentIdToken = "cached-token";

    await expect(bridge.getIdToken()).resolves.toEqual({
      idToken: "cached-token",
    });
    expect(getIdToken).toHaveBeenCalledWith(false);
  });
});

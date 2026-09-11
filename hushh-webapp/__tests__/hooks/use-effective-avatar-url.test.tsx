import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getIdentitySwr: vi.fn(),
  peekCachedIdentity: vi.fn(),
  subscribe: vi.fn(),
  user: {
    uid: "reviewer-user",
    photoURL: "https://avatar.example.test/reviewer.png",
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.user }),
}));

vi.mock("@/lib/services/account-identity-service", () => ({
  AccountIdentityService: {
    getIdentitySwr: mocks.getIdentitySwr,
    peekCachedIdentity: mocks.peekCachedIdentity,
  },
}));

vi.mock("@/lib/services/cache-service", () => ({
  CacheService: {
    getInstance: () => ({ subscribe: mocks.subscribe }),
  },
}));

import { useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";

describe("useEffectiveAvatarUrl", () => {
  afterEach(() => {
    delete window.__HUSHH_NATIVE_TEST__;
    vi.clearAllMocks();
  });

  it("uses the Firebase fallback without refreshing identity during reviewer automation", () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
    };

    const { result } = renderHook(() => useEffectiveAvatarUrl());

    expect(result.current).toBe("https://avatar.example.test/reviewer.png");
    expect(mocks.getIdentitySwr).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});

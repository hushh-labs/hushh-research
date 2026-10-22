import { act, renderHook } from "@testing-library/react";
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

import { providerAvatarAtSize, useEffectiveAvatarUrl } from "@/hooks/use-effective-avatar-url";

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

  it("requests richer Google provider media without rewriting custom or unrelated URLs", () => {
    const provider = "https://lh3.googleusercontent.com/a-/public-fixture=s96-c";
    expect(providerAvatarAtSize(provider)).toBe("https://lh3.googleusercontent.com/a-/public-fixture=s768");
    for (const source of ["https://lh3.googleusercontent.com.evil.test/a/photo=s96", "data:image/png;base64,AA==",
      "https://images.example.test/photo=s96", "https://lh3.googleusercontent.com/a/photo=s96?signature=public-fixture"]) {
      expect(providerAvatarAtSize(source)).toBe(source);
    }
  });

  it("never renders the previous owner's cached photo on the first frame of an account change", () => {
    const original = { ...mocks.user };
    let notify: (() => void) | undefined;
    mocks.subscribe.mockImplementation((listener: () => void) => { notify = listener; return () => undefined; });
    mocks.getIdentitySwr.mockResolvedValue(null);
    mocks.peekCachedIdentity.mockImplementation((uid: string) => uid === original.uid ? { data: { photo_url: "data:image/png;base64,AA==" } } : null);
    const frames: (string | null)[] = [];
    try {
      const { rerender, result } = renderHook(() => { const url = useEffectiveAvatarUrl(768); frames.push(url); return url; });
      expect(result.current).toBe("data:image/png;base64,AA==");
      act(() => { notify?.(); });
      mocks.user.uid = "second-owner";
      mocks.user.photoURL = "https://avatar.example.test/second.png";
      const before = frames.length;
      rerender();
      expect(frames.slice(before)).not.toContain("data:image/png;base64,AA==");
      expect(result.current).toBe(mocks.user.photoURL);
    } finally { Object.assign(mocks.user, original); }
  });
});

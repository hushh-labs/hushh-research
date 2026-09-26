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
    mocks.user = {
      uid: "reviewer-user",
      photoURL: "https://avatar.example.test/reviewer.png",
    };
    vi.resetAllMocks();
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

  it("never renders the previous account's cached avatar during an account switch", () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
    };
    mocks.peekCachedIdentity.mockImplementation((uid: string) => ({
      data: {
        photo_url:
          uid === "reviewer-user"
            ? "https://avatar.example.test/reviewer-custom.png"
            : "https://avatar.example.test/second-custom.png",
      },
    }));

    const seen: Array<{ uid: string; photo: string | null }> = [];
    const { rerender, result } = renderHook(() => {
      const photo = useEffectiveAvatarUrl();
      seen.push({ uid: mocks.user.uid, photo });
      return photo;
    });

    expect(result.current).toBe(
      "https://avatar.example.test/reviewer-custom.png",
    );

    mocks.user = {
      uid: "second-user",
      photoURL: "https://avatar.example.test/second-firebase.png",
    };
    rerender();

    expect(result.current).toBe(
      "https://avatar.example.test/second-custom.png",
    );
    const secondAccountRenders = seen.filter(
      (render) => render.uid === "second-user",
    );
    expect(secondAccountRenders[0]?.photo).toBe(
      "https://avatar.example.test/second-firebase.png",
    );
    expect(secondAccountRenders.at(-1)?.photo).toBe(
      "https://avatar.example.test/second-custom.png",
    );
    expect(secondAccountRenders).not.toContainEqual({
      uid: "second-user",
      photo: "https://avatar.example.test/reviewer-custom.png",
    });
  });
});

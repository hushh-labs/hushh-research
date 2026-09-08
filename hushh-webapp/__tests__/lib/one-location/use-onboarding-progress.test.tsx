import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocationOnboardingProgress } from "@/lib/one-location/use-onboarding-progress";

describe("location onboarding progress", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("checkpoints transitions before unmount and isolates account and journey mode", () => {
    const { result, rerender, unmount } = renderHook(
      ({ userId, mode }) => useLocationOnboardingProgress(userId, mode),
      { initialProps: { userId: "a", mode: "setup" as "setup" | "workspace" } },
    );
    act(() => result.current.setScreen("ready"));
    expect(
      window.sessionStorage.getItem(
        "one_location_onboarding_progress_v1:setup:a",
      ),
    ).toBe("ready");
    rerender({ userId: "b", mode: "setup" });
    expect(result.current.screen).toBe("welcome");
    rerender({ userId: "a", mode: "workspace" });
    expect(result.current.screen).toBe("welcome");
    rerender({ userId: "a", mode: "setup" });
    expect(result.current.screen).toBe("ready");
    unmount();
    const resumed = renderHook(() =>
      useLocationOnboardingProgress("a", "setup"),
    );
    expect(resumed.result.current.screen).toBe("ready");
    act(() => resumed.result.current.clearProgress());
    resumed.unmount();
    expect(
      renderHook(() => useLocationOnboardingProgress("a", "setup")).result
        .current.screen,
    ).toBe("welcome");
  });

  it.each(["garbage", "place"])(
    "safely restores %s without persisting a location draft",
    (stored) => {
      window.sessionStorage.setItem(
        "one_location_onboarding_progress_v1:setup:a",
        stored,
      );
      const { result } = renderHook(() =>
        useLocationOnboardingProgress("a", "setup"),
      );
      expect(result.current.screen).toBe(
        stored === "place" ? "features" : "welcome",
      );
    },
  );

  it("keeps mounted navigation usable when session storage is unavailable", () => {
    const storage = vi
      .spyOn(window, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });
    try {
      const { result } = renderHook(() =>
        useLocationOnboardingProgress("a", "setup"),
      );
      act(() => result.current.setScreen("ready"));
      expect(result.current.screen).toBe("ready");
      expect(() => result.current.clearProgress()).not.toThrow();
    } finally {
      storage.mockRestore();
    }
  });
});

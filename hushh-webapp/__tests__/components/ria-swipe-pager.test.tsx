/** @vitest-environment jsdom */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ pathname: "/ria/profile" }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
}));

import { RiaSwipePager } from "@/components/ria/layout/ria-swipe-pager";

function swipeLeft() {
  fireEvent.touchStart(document, {
    touches: [{ clientX: 320, clientY: 120 }],
    timeStamp: 0,
  });
  fireEvent.touchMove(document, {
    touches: [{ clientX: 180, clientY: 122 }],
    timeStamp: 100,
  });
  fireEvent.touchEnd(document, {
    changedTouches: [{ clientX: 160, clientY: 122 }],
    timeStamp: 140,
  });
}

describe("RiaSwipePager", () => {
  afterEach(() => {
    cleanup();
    navigation.pathname = "/ria/profile";
  });

  it("leaves workspace tab gestures to the shared route pager", () => {
    const onOnboardingSwipe = vi.fn();
    window.addEventListener("ria-onboarding-swipe", onOnboardingSwipe);
    render(
      <RiaSwipePager>
        <div>RIA workspace</div>
      </RiaSwipePager>,
    );

    swipeLeft();

    expect(onOnboardingSwipe).not.toHaveBeenCalled();
    window.removeEventListener("ria-onboarding-swipe", onOnboardingSwipe);
  });

  it("preserves the onboarding step-swipe contract", () => {
    navigation.pathname = "/ria/onboarding";
    const onOnboardingSwipe = vi.fn();
    window.addEventListener("ria-onboarding-swipe", onOnboardingSwipe);
    render(
      <RiaSwipePager>
        <div>RIA onboarding</div>
      </RiaSwipePager>,
    );

    swipeLeft();

    expect(onOnboardingSwipe).toHaveBeenCalledTimes(1);
    expect(onOnboardingSwipe.mock.calls[0]?.[0]).toMatchObject({
      detail: { direction: 1 },
    });
    window.removeEventListener("ria-onboarding-swipe", onOnboardingSwipe);
  });
});

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import OneLoading from "@/app/one/loading";
import OneSetupLoading from "@/app/one/setup/loading";
import RootLoading from "@/app/loading";
import GettingStartedLoading from "@/app/getting-started/loading";
import LoginLoading from "@/app/login/loading";
import RegisterPhoneLoading from "@/app/register-phone/loading";

describe("retained One loading boundaries", () => {
  it("does not replace a ready One surface during a nested route transition", () => {
    const { container } = render(<OneLoading />);

    expect(container).toBeEmptyDOMElement();
  });

  it("leaves setup-specific cold feedback to the active capability adapter", () => {
    const { container } = render(<OneSetupLoading />);

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the retained route shell visible for root and welcome segment transitions", () => {
    for (const LoadingBoundary of [RootLoading, GettingStartedLoading]) {
      const { container, unmount } = render(<LoadingBoundary />);

      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  // A guard redirecting into /login or /register-phone is mid-boot. Its
  // segment fallback paints nothing of its own (no skeleton over the shell)
  // and only holds the stage the one boot surface is already showing, so the
  // surface does not start its exit between two steps of one boot.
  it("holds the auth redirect stage without painting over the retained shell", () => {
    for (const [LoadingBoundary, stage] of [
      [LoginLoading, "redirect"],
      [RegisterPhoneLoading, "phone"],
    ] as const) {
      const { container, unmount } = render(<LoadingBoundary />);

      expect(container.childElementCount).toBe(1);
      const hold = container.firstElementChild as HTMLElement;
      expect(hold).toBeEmptyDOMElement();
      expect(hold.hidden).toBe(true);
      expect(hold.dataset.bootStage).toBe(stage);
      expect(container.querySelector("[role='status']")).toBeNull();
      unmount();
    }
  });
});

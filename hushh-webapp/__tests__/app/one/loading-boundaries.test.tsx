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

  it("keeps the retained route shell visible for root and auth segment transitions", () => {
    for (const LoadingBoundary of [
      RootLoading,
      GettingStartedLoading,
      LoginLoading,
      RegisterPhoneLoading,
    ]) {
      const { container, unmount } = render(<LoadingBoundary />);

      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

type RipplePrototype = HTMLElement & {
  attach?: (control: HTMLElement) => void;
  detach?: () => void;
};

describe("MaterialRipple", () => {
  let attachSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const RippleElement =
      customElements.get("md-ripple") ||
      class TestRippleElement extends HTMLElement {
        disabled = false;
        attach(_control: HTMLElement) {}
        detach() {}
      };

    if (!customElements.get("md-ripple")) {
      customElements.define("md-ripple", RippleElement);
    }

    attachSpy = vi.spyOn(RippleElement.prototype as RipplePrototype, "attach");
  });

  it("attaches the Material ripple controller to the actionable parent", async () => {
    const { container } = render(
      <button type="button">
        Open
        <MaterialRipple variant="link" effect="glass" />
      </button>,
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();

    await waitFor(() => {
      expect(attachSpy).toHaveBeenCalledWith(button);
    });
  });
});

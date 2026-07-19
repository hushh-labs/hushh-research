import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";

type RipplePrototype = HTMLElement & {
  attach?: (control: HTMLElement) => void;
  detach?: () => void;
};

describe("MaterialRipple", () => {
  let attachSpy: ReturnType<typeof vi.spyOn>;
  let disabledSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const RippleElement =
      customElements.get("md-ripple") ||
      class TestRippleElement extends HTMLElement {
        private isDisabled = false;

        get disabled() {
          return this.isDisabled;
        }

        set disabled(value: boolean) {
          this.isDisabled = value;
          disabledSpy(value);
        }

        attach(_control: HTMLElement) {}
        detach() {}
      };

    if (!customElements.get("md-ripple")) {
      customElements.define("md-ripple", RippleElement);
    }

    attachSpy = vi.spyOn(RippleElement.prototype as RipplePrototype, "attach");
    disabledSpy = vi.fn();
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

  it("clears an iOS touchcancel without taking ownership of the button tap", async () => {
    const onClick = vi.fn();
    const { container } = render(
      <button type="button" onClick={onClick}>
        Open
        <MaterialRipple variant="link" effect="glass" />
      </button>,
    );

    const button = container.querySelector("button");
    expect(button).toBeTruthy();

    await waitFor(() => {
      expect(attachSpy).toHaveBeenCalledWith(button);
    });
    disabledSpy.mockClear();

    button?.dispatchEvent(new Event("touchcancel", { bubbles: true }));

    await waitFor(() => {
      expect(disabledSpy).toHaveBeenCalledWith(true);
      expect(disabledSpy).toHaveBeenLastCalledWith(false);
    });
    expect(onClick).not.toHaveBeenCalled();
  });
});

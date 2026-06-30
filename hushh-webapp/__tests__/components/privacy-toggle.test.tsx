import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PrivacyToggle } from "@/components/profile/privacy-toggle";

describe("PrivacyToggle", () => {
  it("exposes switch semantics for privacy preferences", () => {
    render(
      <PrivacyToggle
        checked
        ariaLabel="Toggle marketplace visibility for privacy preferences"
        onCheckedChange={() => {}}
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle marketplace visibility for privacy preferences",
    });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("tabindex")).toBe("0");
  });

  it("toggles from keyboard Enter and Space activation", () => {
    const handleCheckedChange = vi.fn();
    render(
      <PrivacyToggle
        checked={false}
        ariaLabel="Toggle location data for privacy preferences"
        onCheckedChange={handleCheckedChange}
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle location data for privacy preferences",
    });

    fireEvent.keyDown(toggle, { key: "Enter" });
    fireEvent.keyDown(toggle, { key: " " });

    expect(handleCheckedChange).toHaveBeenNthCalledWith(1, true);
    expect(handleCheckedChange).toHaveBeenNthCalledWith(2, true);
  });

  it("does not toggle when disabled", () => {
    const handleCheckedChange = vi.fn();
    render(
      <PrivacyToggle
        checked={false}
        disabled
        ariaLabel="Toggle marketplace visibility for privacy preferences"
        onCheckedChange={handleCheckedChange}
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle marketplace visibility for privacy preferences",
    });

    fireEvent.click(toggle);
    fireEvent.keyDown(toggle, { key: "Enter" });

    expect(toggle.hasAttribute("disabled")).toBe(true);
    expect(toggle.getAttribute("tabindex")).toBe("-1");
    expect(handleCheckedChange).not.toHaveBeenCalled();
  });

  it("reflects unchecked state via aria-checked false", () => {
    render(
      <PrivacyToggle
        checked={false}
        ariaLabel="Toggle analytics data"
        onCheckedChange={() => {}}
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle analytics data",
    });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onCheckedChange with false when initial state is checked and toggle is clicked", () => {
    const handleCheckedChange = vi.fn();
    render(
      <PrivacyToggle
        checked={true}
        ariaLabel="Toggle sync"
        onCheckedChange={handleCheckedChange}
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle sync",
    });

    fireEvent.click(toggle);
    expect(handleCheckedChange).toHaveBeenCalledWith(false);
  });

  it("applies active background/transform classes when checked and propagates custom className", () => {
    const { rerender } = render(
      <PrivacyToggle
        checked={true}
        ariaLabel="Toggle active"
        onCheckedChange={() => {}}
        className="my-custom-toggle"
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle active",
    });

    expect(toggle.className).toContain("bg-primary");
    expect(toggle.className).toContain("my-custom-toggle");
    expect((toggle.firstChild as HTMLElement).className).toContain("translate-x-4");

    rerender(
      <PrivacyToggle
        checked={false}
        ariaLabel="Toggle active"
        onCheckedChange={() => {}}
      />
    );

    expect(toggle.className).toContain("bg-input");
    expect((toggle.firstChild as HTMLElement).className).not.toContain("translate-x-4");
  });

  it("prevents pointerdown event propagation", () => {
    render(
      <PrivacyToggle
        checked={false}
        ariaLabel="Toggle active"
        onCheckedChange={() => {}}
      />
    );

    const toggle = screen.getByRole("switch", {
      name: "Toggle active",
    });

    const pointerDownEvent = new Event("pointerdown", { bubbles: true, cancelable: true });
    const spy = vi.spyOn(pointerDownEvent, "stopPropagation");

    fireEvent(toggle, pointerDownEvent);
    expect(spy).toHaveBeenCalled();
  });
});

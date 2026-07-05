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
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";

describe("AuthProviderButton", () => {
  it("covers provider button type", () => {
    render(
      <AuthProviderButton
        label="Continue with Google"
        icon={<span aria-hidden="true">G</span>}
        onClick={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Continue with Google",
    });

    expect(button).toBeTruthy();
    expect(button.getAttribute("type")).toBe("button");
  });
});

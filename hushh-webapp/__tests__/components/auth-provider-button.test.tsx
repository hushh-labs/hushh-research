import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({
    children,
    type,
    disabled,
  }: {
    children: React.ReactNode;
    type?: string;
    disabled?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

import { AuthProviderButton } from "@/components/onboarding/AuthProviderButton";

describe("AuthProviderButton", () => {
  it("renders with explicit type='button' to prevent accidental form submission", () => {
    const { container } = render(
      <AuthProviderButton label="Google" icon={<span />} />,
    );

    const button = container.querySelector("button");

    expect(button?.getAttribute("type")).toBe("button");
  });
});
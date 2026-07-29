import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";

describe("AuthLegalDialog", () => {
  it("renders accessible close button", () => {
    render(
      <AuthLegalDialog
        docType="privacy"
        onOpenChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /close legal document/i,
      }),
    ).toBeTruthy();
  });

  it("renders external document link", () => {
    render(
      <AuthLegalDialog
        docType="privacy"
        onOpenChange={vi.fn()}
      />,
    );

    const link = screen.getByRole("link", {
      name: /open in browser/i,
    });

    expect(link).toBeTruthy();
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
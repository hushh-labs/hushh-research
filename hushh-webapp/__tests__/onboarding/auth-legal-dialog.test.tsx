import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";

describe("AuthLegalDialog", () => {
  it("renders terms document link target", () => {
    render(
      <AuthLegalDialog
        docType="terms"
        onOpenChange={vi.fn()}
      />,
    );

    const link = screen.getByRole("link", {
      name: /open in browser/i,
    });

    expect(link.getAttribute("href")).toBe("https://www.hushh.ai/terms");
    expect(screen.getByTitle("Terms")).toBeTruthy();
  });
});
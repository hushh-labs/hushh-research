import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AuthLegalDialog } from "@/components/onboarding/AuthLegalDialog";

describe("AuthLegalDialog", () => {
  it("covers close button accessible label", () => {
    render(<AuthLegalDialog docType="privacy" onOpenChange={vi.fn()} />);

    const closeButton = screen.getByRole("button", {
      name: "Close legal document",
    });

    expect(closeButton).toBeTruthy();
    expect(closeButton.getAttribute("type")).toBe("button");
  });
});

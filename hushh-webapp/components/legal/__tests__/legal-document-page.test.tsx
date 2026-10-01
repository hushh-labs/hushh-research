import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LegalDocumentPage } from "../legal-document-page";

const mockBack = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    back: mockBack,
    push: mockPush,
  }),
}));

describe("LegalDocumentPage", () => {
  it("renders privacy policy page with back button and navigates", () => {
    render(<LegalDocumentPage type="privacy" />);

    const backButton = screen.getByRole("button", { name: "Go back" });
    expect(backButton).toBeInTheDocument();

    fireEvent.click(backButton);
    expect(mockPush).toHaveBeenCalledWith("/");
  });

  it("calls router.back when history length is greater than 1", () => {
    Object.defineProperty(window.history, "length", {
      value: 2,
      configurable: true,
    });

    render(<LegalDocumentPage type="privacy" />);

    const backButton = screen.getByRole("button", { name: "Go back" });
    fireEvent.click(backButton);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

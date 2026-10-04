import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LegalDocumentPage } from "../legal-document-page";
import { LegalReader } from "../legal-reader";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/terms",
}));

// The first render imports the whole settings surface; give it room.
describe("LegalDocumentPage", { timeout: 30_000 }, () => {
  it("sits in the app shell and leaves Back to the shell's top bar", () => {
    render(<LegalDocumentPage type="privacy" />);

    const page = screen.getByTestId("legal-privacy-page");
    expect(page.classList.contains("app-page-shell")).toBe(true);
    expect(within(page).getByTestId("page-header")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy Policy" }),
    ).toBeTruthy();
    // The page used to draw its own back chip outside the shell's top bar.
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  });

  it("opens the other document by replacing this one", () => {
    render(<LegalDocumentPage type="terms" />);

    const seeAlso = within(
      screen.getByTestId("legal-reader-open-privacy"),
    ).getByRole("link");
    expect(seeAlso.getAttribute("href")).toBe("/privacy");
  });
});

describe("LegalReader", { timeout: 30_000 }, () => {
  it("uses the app's type roles for every heading and paragraph", () => {
    render(<LegalReader type="terms" navigation={{ kind: "route" }} />);

    const body = screen.getByTestId("legal-reader-body");
    const sections = body.querySelectorAll("section");
    expect(sections.length).toBe(LEGAL_DOCUMENTS.terms.sections.length);
    for (const heading of body.querySelectorAll("h2")) {
      expect(heading.getAttribute("data-ui-role")).toBe("section-title");
    }
    for (const paragraph of body.querySelectorAll("p, li")) {
      expect(paragraph.getAttribute("data-ui-role")).toBe("body");
    }
    // No private type scale: no raw pixel sizes on the reader's own text.
    expect(body.innerHTML).not.toMatch(/text-\[\d+px\]/);
  });

  it("swaps documents in place inside Profile instead of leaving for a page", () => {
    const open = vi.fn();
    render(<LegalReader type="terms" navigation={{ kind: "in-place", open }} />);

    fireEvent.click(
      within(screen.getByTestId("legal-reader-open-privacy")).getByRole(
        "button",
      ),
    );
    expect(open).toHaveBeenCalledWith("privacy");

    // The Terms text links to the Privacy Policy; inside Profile it opens in
    // place too.
    const inline = screen
      .getAllByRole("link", { name: "Privacy Policy" })
      .find((link) => link.closest("[data-testid='legal-reader-body']"));
    expect(inline).toBeTruthy();
    fireEvent.click(inline!);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

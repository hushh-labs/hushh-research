import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LegalDocumentPage } from "../legal-document-page";
import { LegalReader } from "../legal-reader";
import { LEGAL_DOCUMENTS } from "@/lib/legal/legal-documents";
import { projectNativeLegalDocument, validNativeLegalDocument } from "@/lib/capacitor/native-profile-legal";
import { projectNativeProfileLegal } from "@/components/profile/profile-native-legal";

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
  for (const type of ["privacy", "terms"] as const) {
    for (const kind of ["route", "in-place"] as const) {
      it(`preserves every word, block and link in ${type} (${kind})`, () => {
        render(<LegalReader type={type} navigation={kind === "route" ? { kind } : { kind, open: vi.fn() }} />);
        const body = screen.getByTestId("legal-reader-body");
        const doc = LEGAL_DOCUMENTS[type];
        const text = (parts: (string | { text: string })[]) => parts.map(part => typeof part === "string" ? part : part.text).join("");
        const expectedBlocks = doc.sections.flatMap(section => [
          { tag: "h2", text: section.title },
          ...section.blocks.flatMap(block => block.kind === "p" ? [{ tag: "p", text: text(block.text) }]
            : block.kind === "h" ? [{ tag: "h3", text: block.text }]
              : block.items.map(item => ({ tag: "li", text: text(item) }))),
        ]);
        expect([...body.querySelectorAll("h2, h3, p, li")].map(node => ({
          tag: node.tagName.toLowerCase(), text: node.textContent,
        }))).toEqual(expectedBlocks);
        const expectedLinks = doc.sections.flatMap(section => section.blocks.flatMap(block =>
          block.kind === "p" ? block.text : block.kind === "list" ? block.items.flat() : [],
        )).filter(part => typeof part !== "string");
        expect([...body.querySelectorAll("a")].map(node => ({ text: node.textContent, href: node.getAttribute("href") }))).toEqual(expectedLinks);
      });
    }
  }

  it("preserves every authored block and link in the native reader without transferring executable URLs", () => {
    for (const type of ["privacy", "terms"] as const) {
      const { document, links } = projectNativeLegalDocument(type);
      expect(validNativeLegalDocument(document)).toBe(true);
      const restore = (parts: { text: string; actionId?: string }[]) => parts.map(part => part.actionId ?
        { text: part.text, href: links.get(part.actionId) } : part.text);
      expect(document.sections.map(section => ({ ...section, blocks: section.blocks.map(block =>
        block.kind === "p" ? { ...block, text: restore(block.text) } : block.kind === "list" ?
          { ...block, items: block.items.map(restore) } : block) }))).toEqual(LEGAL_DOCUMENTS[type].sections);
      expect(validNativeLegalDocument({ ...document, url: "https://example.com" } as never)).toBe(false);
      const duplicate = structuredClone(document);
      const paragraph = duplicate.sections.flatMap(section => section.blocks).find(block => block.kind === "p")!;
      if (paragraph.kind === "p") paragraph.text[0].actionId = duplicate.related.actionId;
      expect(validNativeLegalDocument(duplicate)).toBe(false);
      const open = vi.fn(), deletion = vi.fn();
      const projected = projectNativeProfileLegal(type, open, deletion);
      projected.rows.get(document.related.actionId)!({} as never);
      expect(open).toHaveBeenCalledWith(type === "privacy" ? "terms" : "privacy", "replace");
      expect(projected.pages.map(page => page.id)).toEqual(["legal", type]);
      expect(deletion).not.toHaveBeenCalled();
      expect(projected.rows.has("invented-link")).toBe(false);
    }
  });
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

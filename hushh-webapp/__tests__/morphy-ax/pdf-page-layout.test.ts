import { describe, expect, it } from "vitest";

import {
  renderPdfPageRules,
  resolvePdfLayout,
} from "../../scripts/reports/export-markdown-pdf.mjs";

const formatter = {
  page: {
    size: "A4",
    readingMarginBlock: "18mm",
    readingMarginInline: "14mm",
  },
};

describe("PDF page geometry", () => {
  it("assigns a first executive cover to an edge-to-edge named page", () => {
    const layout = resolvePdfLayout(`<!-- pdf:cover-start -->
Cover content.
<!-- pdf:cover-end -->
<!-- pdf:page-break -->
# Body`, "executive");

    expect(layout).toEqual({ hasFullBleedCover: true });
    expect(renderPdfPageRules(formatter, layout)).toContain("@page pdf-cover");
    expect(renderPdfPageRules(formatter, layout)).toContain("margin: 0;");
    expect(renderPdfPageRules(formatter, layout)).toContain("margin: 18mm 14mm;");
  });

  it("rejects a cover that could produce a partial-bleed page", () => {
    expect(() =>
      resolvePdfLayout(`Intro first.\n<!-- pdf:cover-start -->\nCover\n<!-- pdf:cover-end -->`, "executive"),
    ).toThrow("first semantic block");

    expect(() =>
      resolvePdfLayout(`<!-- pdf:cover-start -->\nCover\n<!-- pdf:cover-end -->`, "executive"),
    ).toThrow("pdf:page-break");

    expect(() =>
      resolvePdfLayout(`<!-- pdf:cover-start -->\nCover\n<!-- pdf:cover-end -->\n<!-- pdf:page-break -->`, "technical"),
    ).toThrow("only with --profile executive");
  });

  it("keeps ordinary reports on the readable page geometry", () => {
    const layout = resolvePdfLayout("# Technical note", "technical");

    expect(layout).toEqual({ hasFullBleedCover: false });
    expect(renderPdfPageRules(formatter, layout)).not.toContain("@page pdf-cover");
  });
});

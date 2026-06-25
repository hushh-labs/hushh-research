import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on white-space / layout.
//
// TRUTH-FIRST (verified against the source):
//   - Output is NOT minified and is NOT a structural JSON block. It is a
//     newline-joined, human-readable line list: `return lines.join("\n")`.
//   - The separator is a single LF ("\n") — never CRLF and never tabs.
//   - Indentation is SPACES only: top-level scalars unindented, object/array
//     children prefixed with two spaces ("  "), nested object fields with four
//     ("    • "). No "\t" anywhere.
//   - Object/array sections are preceded by ONE blank line (an empty string
//     pushed before the "--- Label ---" header), giving a fixed newline pattern
//     between a leading scalar and a following section.
//   - There is no trailing newline; join() only inserts separators BETWEEN
//     lines.

describe("formatCompleteJson — white-space / layout invariants", () => {
  it("joins multiple top-level scalars with single LF, no trailing newline", () => {
    const out = formatCompleteJson({ alpha: "one", beta: "two" });
    expect(out).toBe("Alpha: one\nBeta: two");
    expect(out.endsWith("\n")).toBe(false);
  });

  it("never emits tab characters or CRLF", () => {
    const out = formatCompleteJson({
      portfolio_summary: { ending_value: 100, note: "hello" },
    });
    expect(out).not.toContain("\t");
    expect(out).not.toContain("\r");
  });

  it("is not minified — does not collapse into a single { } JSON block", () => {
    const out = formatCompleteJson({ alpha: "one", beta: "two" });
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
    expect(out).toContain("\n");
  });

  it("uses a fixed two-space indent for object section children", () => {
    const out = formatCompleteJson({ portfolio_summary: { note: "hi" } });
    const lines = out.split("\n");
    // Pattern: "", "--- Portfolio Summary ---", "  Note: hi"
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe("--- Portfolio Summary ---");
    expect(lines[2]).toBe("  Note: hi");
  });

  it("uses a four-space bullet indent for nested object fields", () => {
    const out = formatCompleteJson({
      portfolio_summary: { totals: { gross: "x" } },
    });
    expect(out).toContain("  Totals:");
    expect(out).toContain("    • Gross: x");
  });

  it("prefixes a section with exactly one blank line after a leading scalar", () => {
    const out = formatCompleteJson({
      alpha: "one",
      portfolio_summary: { note: "hi" },
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Alpha: one");
    expect(lines[1]).toBe(""); // single blank-line separator
    expect(lines[2]).toBe("--- Portfolio Summary ---");
    expect(lines[3]).toBe("  Note: hi");
  });

  it("does not compress interior whitespace inside preserved string values", () => {
    const out = formatCompleteJson({ alpha: "a    b\tc" });
    // String branch only strips markdown + trims ends; interior spaces/tabs kept.
    expect(out).toBe("Alpha: a    b\tc");
  });
});

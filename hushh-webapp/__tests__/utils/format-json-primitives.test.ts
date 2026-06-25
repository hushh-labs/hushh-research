import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) focused on the EXACT, narrow contract
// for boolean values, stringified-symbol values, and unmapped primitive keys.
//
// Truth-first, verified against the source:
//   - Top-level scalar emission only fires for `typeof === "number" | "string"`
//     (line 239). A TOP-LEVEL boolean is neither number/string, not an array,
//     and `typeof boolean !== "object"`, so it matches NO branch and is SILENTLY
//     SKIPPED — it produces no line at all.
//   - A boolean nested INSIDE an object value routes through formatValue, whose
//     boolean branch returns the literal "Yes" (true) or "No" (false).
//   - formatValue never throws: numbers format, strings are markdown-cleaned,
//     booleans map to Yes/No, and anything else falls through to String(value).
//   - Unmapped primitive keys are title-cased via getFieldLabel (ASCII \b\w).
// These tests pin that precise behavior, including the top-level-boolean skip.

describe("formatCompleteJson — boolean and symbol primitives", () => {
  it("SKIPS a top-level boolean entirely (no line emitted)", () => {
    expect(formatCompleteJson({ is_active: true })).toBe("");
    expect(formatCompleteJson({ is_active: false })).toBe("");
  });

  it("renders a boolean nested in an object as 'Yes' / 'No'", () => {
    const out = formatCompleteJson({
      account_metadata: { is_verified: true, is_closed: false },
    });
    expect(out).toContain("  Is Verified: Yes");
    expect(out).toContain("  Is Closed: No");
  });

  it("emits an unmapped string primitive with a title-cased key", () => {
    const out = formatCompleteJson({ custom_status: "active" });
    // "custom_status" -> "Custom Status"; string value markdown-cleaned verbatim.
    expect(out).toContain("Custom Status: active");
  });

  it("strips markdown markers from a string primitive value", () => {
    const out = formatCompleteJson({ note: "**bold** and `code`" });
    expect(out).toContain("Note: bold and code");
    expect(out).not.toContain("**");
    expect(out).not.toContain("`");
  });

  it("formats an unmapped numeric primitive with grouping (not currency)", () => {
    const out = formatCompleteJson({ widget_count: 1234567 });
    // formatNumber uses en-US grouping; widget_count is not a currency field.
    expect(out).toContain("Widget Count: 1,234,567");
  });

  it("does not throw and skips null/undefined primitive values", () => {
    expect(() =>
      formatCompleteJson({ a: null, b: undefined, c: "ok" })
    ).not.toThrow();
    const out = formatCompleteJson({ a: null, b: undefined, c: "ok" });
    expect(out).toBe("C: ok");
  });

  it("renders nested booleans alongside nested string primitives", () => {
    const out = formatCompleteJson({
      portfolio_summary: { reconciled: true, label: "Q1" },
    });
    expect(out).toContain("  Reconciled: Yes");
    expect(out).toContain("  Label: Q1");
  });
});

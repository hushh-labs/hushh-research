import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson in lib/utils/json-to-human.ts,
// focused on how string values populated with tabs, newlines, and multi-line
// padding survive a formatting pass — and how structural indentation behaves.
//
// Truth-first note on the real implementation (verified against source):
//
//   String values flow through formatValue() -> cleanMarkdown(), which does:
//       text.replace(/\*\*\*/g,'').replace(/\*\*/g,'').replace(/\*/g,'')
//           .replace(/`/g,'').trim();
//   So for whitespace specifically:
//     - `.trim()` removes leading/trailing whitespace (spaces, tabs, newlines)
//       at the EDGES of the string only.
//     - INTERNAL whitespace is NOT collapsed or normalized — interior tabs (\t),
//       newlines (\n), and runs of spaces are preserved verbatim.
//     - A value that is entirely whitespace trims down to "" (empty).
//   (Note: the /\s+/g collapse lives in formatJsonChunk's live-preview path,
//    NOT in formatCompleteJson. This suite covers formatCompleteJson only.)
//
//   Structural indentation is a FIXED, hard-coded prefix per level, independent
//   of the value's own content:
//     - object field line:        `  ${label}: ${value}`   (2 spaces)
//     - nested object header:     `  ${label}:`            (2 spaces)
//     - nested object leaf line:  `    • ${label}: ${value}` (4 spaces + "• ")
//   Because the indent string is a literal and never derived from the payload,
//   the alignment is identical across repeated calls and unaffected by any
//   whitespace inside the values. Lines are joined with "\n".
//
// These tests pin that ACTUAL contract (edge-trim only, interior preserved,
// fixed structural indent) rather than assuming a normalize/reflow pass.

describe("formatCompleteJson — structural whitespace padding", () => {
  it("trims edge whitespace (tabs/newlines/spaces) on string values", () => {
    const out = formatCompleteJson({
      account_metadata: {
        institution_name: "\t\n  Acme Bank  \n\t",
      },
    });
    // Edges trimmed -> exactly "Institution: Acme Bank", no leading/trailing pad.
    expect(out).toContain("Institution: Acme Bank");
    expect(out).not.toContain("Institution: \t");
    expect(out).not.toContain("Acme Bank  ");
  });

  it("preserves INTERNAL tabs and newlines verbatim (no collapse)", () => {
    const out = formatCompleteJson({
      account_metadata: {
        account_holder: "Line1\n\tLine2\t\tLine3",
      },
    });
    // Interior \n and \t survive untouched between the non-space content.
    expect(out).toContain("Account Holder: Line1\n\tLine2\t\tLine3");
  });

  it("collapses a fully-whitespace string value to empty after the label", () => {
    const out = formatCompleteJson({
      account_metadata: {
        account_type: "\t\n   \n\t",
      },
    });
    // Whitespace-only -> trim() -> "" -> "Account Type: " with nothing after.
    expect(out).toContain("Account Type: ");
    expect(out).not.toContain("Account Type: \t");
  });

  it("applies a fixed 2-space structural indent regardless of value whitespace", () => {
    const out = formatCompleteJson({
      portfolio_summary: {
        beginning_value: 1000,
        ending_value: 1250,
      },
    });
    const lines = out.split("\n");
    const fieldLines = lines.filter((l: string) => l.includes(": "));
    // Every object field line begins with exactly two spaces.
    for (const line of fieldLines) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line.startsWith("   ")).toBe(false);
    }
  });

  it("uses a fixed 4-space '• ' indent for nested-object leaf lines", () => {
    const out = formatCompleteJson({
      ytd_metrics: {
        year_to_date_totals: {
          total_income: 250,
        },
      },
    });
    // Nested header at 2 spaces, nested leaf at 4 spaces + bullet.
    expect(out).toContain("  Year To Date Totals:");
    expect(out).toContain("    • Total Income: $250.00");
  });

  it("produces byte-identical output across repeated formatting passes", () => {
    const payload = {
      account_metadata: {
        institution_name: "  Padded\tBank\nName  ",
        account_holder: "A\t\tB",
      },
      portfolio_summary: {
        beginning_value: 1000,
      },
    };
    const first = formatCompleteJson(payload);
    const second = formatCompleteJson(payload);
    // Formatting is pure/deterministic — indent alignment stays consistent.
    expect(second).toBe(first);
  });

  it("keeps section/field structure intact when many values carry padding", () => {
    const out = formatCompleteJson({
      account_metadata: {
        institution_name: "\tBank\t",
        account_number: "  12345  ",
        account_type: "\nBrokerage\n",
      },
    });
    expect(out).toContain("--- Account Information ---");
    expect(out).toContain("Institution: Bank");
    expect(out).toContain("Account Number: 12345");
    expect(out).toContain("Account Type: Brokerage");
  });
});

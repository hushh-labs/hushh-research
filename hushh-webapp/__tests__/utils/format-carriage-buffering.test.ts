import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for formatCompleteJson
 * (hushh-webapp/lib/utils/json-to-human.ts) when object string values contain
 * raw Windows-style carriage-return line endings (CR LF) injected throughout
 * the dictionary structures.
 *
 * TRUTH-FIRST (verified against the source):
 *   formatCompleteJson builds its output from STATIC literal indentation
 *   prefixes and joins every line with a literal "\n":
 *     - object fields:   "  " + Label + ": " + value
 *     - nested fields:   "    \u2022 " + Label + ": " + value
 *     - array items:     "  \u2022 " + value
 *     - section header:  "--- Label ---" (preceded by an empty "" line)
 *     - final assembly:  lines.join("\n")
 *   There is NO indentation-alignment computation, NO terminal/platform
 *   detection, and NO CR/LF normalization. The ONLY mutation applied to string
 *   values is cleanMarkdown(value) -> ... .trim(), which strips markdown markers
 *   and OUTER whitespace (so leading/trailing CR LF are removed) but leaves
 *   INTERIOR CR LF untouched. Consequences pinned below:
 *     - The structural line separator is always "\n" (LF), never "\r\n", on any
 *       platform -- so the output is platform-stable by construction.
 *     - Interior "\r\n" inside a string value survives verbatim, embedding raw
 *       CR LF in the middle of an otherwise statically-indented line.
 *     - Leading/trailing "\r\n" around a string value is removed by trim().
 *     - Generic-array branch uses String(...) WITHOUT trim, so even outer
 *       "\r\n" survives there.
 *     - Static indentation prefixes are emitted regardless of CR LF content.
 */

const CRLF = "\r\n";

describe("formatCompleteJson — raw CR LF buffering in string values", () => {
  it("joins structural lines with LF only (never CR LF) on any platform", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: "Brokerage" },
    });
    expect(out).toBe("\n--- Account Information ---\n  Account Type: Brokerage");
    expect(out).not.toContain(CRLF);
  });

  it("preserves interior CR LF inside an object field value verbatim", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: `Line1${CRLF}Line2` },
    });
    expect(out).toBe(
      `\n--- Account Information ---\n  Account Type: Line1${CRLF}Line2`
    );
  });

  it("trims leading/trailing CR LF around a value but keeps the static indent", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: `${CRLF}${CRLF}Brokerage${CRLF}` },
    });
    expect(out).toBe("\n--- Account Information ---\n  Account Type: Brokerage");
  });

  it("keeps interior CR LF while still applying the nested bullet indent", () => {
    const out = formatCompleteJson({
      account_metadata: { nested: { account_type: `A${CRLF}B` } },
    });
    expect(out).toBe(
      `\n--- Account Information ---\n  Nested:\n    \u2022 Account Type: A${CRLF}B`
    );
  });

  it("emits CR LF-laden values across multiple fields with stable static prefixes", () => {
    const out = formatCompleteJson({
      account_metadata: {
        institution_name: `Acme${CRLF}Bank`,
        account_type: `Roth${CRLF}IRA`,
      },
    });
    expect(out).toBe(
      [
        "",
        "--- Account Information ---",
        `  Institution: Acme${CRLF}Bank`,
        `  Account Type: Roth${CRLF}IRA`,
      ].join("\n")
    );
  });

  it("retains CR LF in a generic-array value via String() without trimming", () => {
    const out = formatCompleteJson({
      misc: [{ note: `${CRLF}row${CRLF}` }],
    } as Record<string, unknown>);
    // Generic array branch prints the first defined value with String(...),
    // which does NOT trim, so outer CR LF survives too.
    expect(out).toBe(`\n--- Misc (1 items) ---\n  \u2022 ${CRLF}row${CRLF}`);
  });

  it("keeps a top-level scalar string's interior CR LF intact", () => {
    const out = formatCompleteJson({ account_type: `X${CRLF}Y` } as Record<
      string,
      unknown
    >);
    expect(out).toBe(`Account Type: X${CRLF}Y`);
  });

  it("never throws for CR LF-dense structures and returns a string", () => {
    expect(() =>
      formatCompleteJson({
        account_metadata: {
          account_type: `${CRLF}${CRLF}a${CRLF}b${CRLF}${CRLF}`,
        },
      })
    ).not.toThrow();
  });
});

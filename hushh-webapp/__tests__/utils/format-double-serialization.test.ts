import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for `formatCompleteJson` from
 * `hushh-webapp/lib/utils/json-to-human.ts`.
 *
 * Scope: pin down the *exact* contract when a payload contains a value that is
 * itself an already-serialized ("double-encoded") JSON string literal, for
 * example `{ note: '{"nested":true}' }`.
 *
 * Truth-first note: this formatter does NOT recursively parse or decode string
 * values. Inspection of the implementation shows string values are routed
 * through `formatValue` -> `cleanMarkdown`, which only trims and strips markdown
 * tokens (`*`, `**`, `***`, backticks). It never calls `JSON.parse` on a value.
 * Therefore a pre-serialized JSON string is emitted VERBATIM (its inner braces,
 * quotes, and structure are preserved as opaque text), and it is NOT expanded
 * into nested bullets. The only mutation is markdown stripping, which can
 * silently corrupt embedded JSON strings that happen to contain `*` or
 * backticks. These tests document that real behavior, not an aspirational one.
 */
describe("formatCompleteJson — double-serialized JSON string values", () => {
  it("emits a top-level pre-serialized JSON string verbatim, without re-parsing", () => {
    const inner = '{"nested":true}';

    const out = formatCompleteJson({ note: inner });

    // Passes through as opaque text: label + the literal serialized string.
    expect(out).toBe(`Note: ${inner}`);

    // Explicitly assert it is NOT decoded/expanded into a nested structure.
    expect(out).not.toContain("Nested:");
    expect(out).not.toContain("• ");
  });

  it("preserves inner structural tokens (braces/quotes/colons) as literal characters", () => {
    const inner = '{"a":{"b":[1,2]}}';

    const out = formatCompleteJson({ payload: inner });

    expect(out).toBe(`Payload: ${inner}`);
    // Brace balance is preserved byte-for-byte (no structural rewriting).
    expect(out.match(/\{/g)?.length).toBe(2);
    expect(out.match(/\}/g)?.length).toBe(2);
  });

  it("silently corrupts embedded markdown-like tokens inside the serialized string", () => {
    // The embedded JSON contains `*` and backticks, which cleanMarkdown strips.
    const inner = '{"expr":"3 * 4 = 12","code":"`x`"}';

    const out = formatCompleteJson({ note: inner });

    // `*` removed (leaving a double space) and backticks removed.
    expect(out).toBe('Note: {"expr":"3  4 = 12","code":"x"}');
  });

  it("passes a nested-object serialized string through under a section header, still un-parsed", () => {
    const inner = '{"raw":true}';

    const out = formatCompleteJson({ metadata: { payload: inner } });

    expect(out).toBe(`\n--- Metadata ---\n  Payload: ${inner}`);
    expect(out).not.toContain("Raw:");
  });

  it("trims surrounding whitespace on the serialized string but keeps interior spacing", () => {
    const inner = '   {"k": "v"}   ';

    const out = formatCompleteJson({ note: inner });

    // cleanMarkdown trims the outer whitespace; interior spacing is untouched.
    expect(out).toBe('Note: {"k": "v"}');
  });
});

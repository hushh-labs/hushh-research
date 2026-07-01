import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

/**
 * Characterization tests for formatCompleteJson
 * (hushh-webapp/lib/utils/json-to-human.ts) when an object's STRING values
 * contain literal stringified JSON structural delimiters
 * (e.g. a value like { "a": [1, 2] } or raw closing runs like }}]] ).
 *
 * TRUTH-FIRST (verified against the source):
 *   formatCompleteJson is a plain recursive WALK over the already-parsed object
 *   graph. String leaves flow through formatValue(key, value) ->
 *   cleanMarkdown(value), whose ONLY transforms are: remove triple-asterisk
 *   (bold+italic) markers, remove double-asterisk (bold) markers, remove single
 *   asterisk (italic) markers, remove code backticks, then trim() surrounding
 *   whitespace.
 *   There is NO JSON re-parsing, NO bracket/brace/colon/comma lookahead, NO
 *   delimiter balancing, and NO whitespace collapsing inside the value. JSON
 *   structural characters (curly braces, square brackets, colon, comma) are NOT
 *   in cleanMarkdown's character class, so they pass through untouched.
 *   Consequences pinned below:
 *     - A value that is a stringified JSON object/array is emitted verbatim
 *       (only outer whitespace trimmed) -- no special tracking or layout break.
 *     - Raw closing runs like }}]] survive unchanged.
 *     - The line shape stays the flat "  <Label>: <value>" form regardless of
 *       how "JSON-like" the value text is.
 *     - The ONLY mutation is markdown/backtick stripping + trim; asterisks that
 *       happen to sit inside JSON-looking text are still removed.
 */

describe("formatCompleteJson — stringified JSON delimiters in values are passed through", () => {
  it("emits a stringified JSON object value verbatim (inner spacing preserved)", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: '{ "a": [1, 2] }' },
    });
    expect(out).toBe(
      '\n--- Account Information ---\n  Account Type: { "a": [1, 2] }'
    );
  });

  it("preserves a raw closing-delimiter run unchanged", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: "tail}}]]" },
    });
    expect(out).toBe("\n--- Account Information ---\n  Account Type: tail}}]]");
  });

  it("does not collapse internal whitespace inside a JSON-looking value", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: '{   "x":    [ 1 ,  2 ] }' },
    });
    expect(out).toBe(
      '\n--- Account Information ---\n  Account Type: {   "x":    [ 1 ,  2 ] }'
    );
  });

  it("keeps a top-level scalar JSON-looking string intact", () => {
    const out = formatCompleteJson({ total_value: '[{"k": "v"}]' } as Record<
      string,
      unknown
    >);
    // total_value is a CURRENCY field, but currency formatting only applies to
    // numbers; a string flows through formatValue -> cleanMarkdown unchanged.
    expect(out).toBe('Total Portfolio Value: [{"k": "v"}]');
  });

  it("preserves delimiters but still strips markdown asterisks/backticks + trims", () => {
    const out = formatCompleteJson({
      account_metadata: { account_type: '  `{ "a": **[1, 2]** }`  ' },
    });
    expect(out).toBe(
      '\n--- Account Information ---\n  Account Type: { "a": [1, 2] }'
    );
  });

  it("passes structural delimiters through at nested object depth", () => {
    const out = formatCompleteJson({
      account_metadata: { nested: { account_type: '{"deep": [null]}' } },
    });
    expect(out).toBe(
      '\n--- Account Information ---\n  Nested:\n    • Account Type: {"deep": [null]}'
    );
  });

  it("treats a stringified-JSON value inside a generic array as opaque text", () => {
    const out = formatCompleteJson({
      misc: [{ note: '{"a":[1,2]}' }],
    } as Record<string, unknown>);
    // Generic array branch prints the first defined value via String(...).
    expect(out).toBe('\n--- Misc (1 items) ---\n  • {"a":[1,2]}');
  });

  it("never throws and returns a string for delimiter-heavy values", () => {
    expect(() =>
      formatCompleteJson({
        account_metadata: { account_type: '}}]]{{[[":,:,' },
      })
    ).not.toThrow();
  });
});

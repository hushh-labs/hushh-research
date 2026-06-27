import { describe, expect, it } from "vitest";

import { formatCompleteJson } from "@/lib/utils/json-to-human";

// Characterization tests for formatCompleteJson
// (hushh-webapp/lib/utils/json-to-human.ts) when native JavaScript Error
// instances are embedded directly as dictionary values.
//
// TRUTH-FIRST — LITERAL CONTRACT:
//
// formatCompleteJson iterates exclusively with `Object.entries(...)` at every
// level. `Object.entries` returns only OWN + ENUMERABLE + string-keyed
// properties. On a native Error, the standard `message`, `stack`, and `name`
// properties are NON-ENUMERABLE (message/stack are own-but-non-enumerable; name
// lives on the prototype). Therefore:
//
//   - An Error passed as a top-level SECTION value is `typeof === "object"` and
//     not an array, so it emits the section header block:
//         ""                       (blank separator line)
//         "--- <Label> ---"
//     and then `Object.entries(error)` yields NOTHING enumerable, so NO
//     `message`/`stack`/`name` lines are produced.
//
//   - The ONLY way Error content surfaces is via OWN ENUMERABLE properties that
//     code explicitly assigns (e.g. `err.code = "E_FAIL"`), which `Object.entries`
//     then does include.
//
// These tests pin that real mapping baseline: stack traces and the built-in
// message are invisible; only explicitly-assigned enumerable fields render.

describe("formatCompleteJson — native Error instances as values", () => {
  it("emits only the section header for a bare Error (message/stack are non-enumerable)", () => {
    const out = formatCompleteJson({ failure: new Error("failed task") });
    expect(out).toBe("\n--- Failure ---");
  });

  it("does not leak the Error message anywhere in the output", () => {
    const out = formatCompleteJson({ failure: new Error("failed task") });
    expect(out).not.toContain("failed task");
    expect(out).not.toContain("message");
  });

  it("does not leak the Error stack trace into the output", () => {
    const err = new Error("boom");
    const out = formatCompleteJson({ failure: err });
    expect(out).not.toContain("stack");
    // A real stack mentions this test file / "Error:"; none of it should appear.
    expect(out).not.toContain("Error:");
    expect(out).not.toContain(".test.ts");
  });

  it("renders ONLY explicitly-assigned own enumerable properties on an Error", () => {
    const err = new Error("failed task") as Error & {
      code?: string;
      detail?: string;
    };
    err.code = "E_FAIL";
    err.detail = "downstream timeout";
    const out = formatCompleteJson({ failure: err });
    // Header + the two enumerable fields, in insertion order; message/stack absent.
    expect(out).toBe(
      [
        "",
        "--- Failure ---",
        "  Code: E_FAIL",
        "  Detail: downstream timeout",
      ].join("\n"),
    );
  });

  it("treats a nested Error value as an empty object (label with no children)", () => {
    const out = formatCompleteJson({
      section: { cause: new Error("nested failure") },
    });
    // The Error is object & non-array → emits the "Cause:" label header, then
    // Object.entries(error) yields nothing enumerable → no nested bullet lines.
    expect(out).toBe(
      ["", "--- Section ---", "  Cause:"].join("\n"),
    );
    expect(out).not.toContain("nested failure");
  });

  it("renders an Error inside an array via the generic first-enumerable-value path", () => {
    // Generic array branch uses Object.values(item).find(...) for the first
    // non-null value. A bare Error has no enumerable values → falls back to
    // the literal string "Item".
    const out = formatCompleteJson({ items: [new Error("x")] });
    expect(out).toBe(
      ["", "--- Items (1 items) ---", "  • Item"].join("\n"),
    );
    expect(out).not.toContain("x");
  });

  it("uses the first enumerable own value for an Error in an array when one exists", () => {
    const err = new Error("ignored message") as Error & { code?: string };
    err.code = "E42";
    const out = formatCompleteJson({ items: [err] });
    expect(out).toBe(
      ["", "--- Items (1 items) ---", "  • E42"].join("\n"),
    );
    expect(out).not.toContain("ignored message");
  });

  it("renders subclass-ASSIGNED fields (incl. an assigned name) but never the built-in message", () => {
    // NUANCE pinned by the local run: assigning `this.name = ...` in a subclass
    // constructor creates an OWN ENUMERABLE `name` that SHADOWS the prototype's
    // non-enumerable `name`. So an assigned `name` DOES render, as does any
    // assigned `status`. The built-in (super) `message` stays non-enumerable and
    // remains hidden.
    class HttpError extends Error {
      status: number;
      constructor(message: string, status: number) {
        super(message);
        this.name = "HttpError"; // assignment → own + enumerable → rendered
        this.status = status; // own + enumerable → rendered
      }
    }
    const out = formatCompleteJson({ request: new HttpError("nope", 503) });
    expect(out).toBe(
      ["", "--- Request ---", "  Status: 503", "  Name: HttpError"].join("\n"),
    );
    // The super() message is non-enumerable → never surfaces.
    expect(out).not.toContain("nope");
  });
});

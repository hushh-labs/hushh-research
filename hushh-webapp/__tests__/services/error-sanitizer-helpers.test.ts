import { describe, expect, it } from "vitest";

import {
  extractErrorCode,
  getErrorMessage,
  isError,
} from "@/lib/services/error-sanitizer";

// ─────────────────────────────────────────────────────────────────────────────
// isError / getErrorMessage / extractErrorCode — characterization tests
//
// All three functions are pure, have no IO, and require no mocks.
//
// NOTE: The existing __tests__/services/error-sanitizer.test.ts (or similar)
// covers sanitizeErrorMessage.  This file covers only the three utilities
// that are NOT tested there.
//
// ── isError ──────────────────────────────────────────────────────────────────
//   export function isError(value: unknown): value is Error {
//     return value instanceof Error;
//   }
//   Single branch: instanceof check — no special cases.
//
// ── getErrorMessage ───────────────────────────────────────────────────────────
//   export function getErrorMessage(error: unknown): string {
//     if (isError(error))            return error.message;
//     if (typeof error === "string") return error;
//     return String(error);
//   }
//   Three explicit branches in priority order.
//
// ── extractErrorCode ──────────────────────────────────────────────────────────
//   export function extractErrorCode(error: unknown): string | null {
//     if (error instanceof Error) {
//       const match = error.message.match(/^([A-Z_]+):/);
//       return match ? match[1]! : null;
//     }
//     return null;
//   }
//   Guard: must be an Error instance.
//   Regex: /^([A-Z_]+):/ — requires one or more uppercase-ASCII or underscore
//   characters starting at position 0, followed immediately by ':'.
//   Mixed-case or lowercase prefixes do NOT match.
// ─────────────────────────────────────────────────────────────────────────────

describe("isError", () => {
  it("returns true for a plain Error instance", () => {
    expect(isError(new Error("boom"))).toBe(true);
  });

  it("returns true for a TypeError (subclass of Error)", () => {
    // instanceof traverses the prototype chain — all built-in error subclasses qualify.
    expect(isError(new TypeError("type problem"))).toBe(true);
  });

  it("returns true for a RangeError", () => {
    expect(isError(new RangeError("out of range"))).toBe(true);
  });

  it("returns false for a plain string", () => {
    expect(isError("error string")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isError(undefined)).toBe(false);
  });

  it("returns false for a plain object that looks like an error", () => {
    // { message: "..." } is NOT an Error instance — instanceof check fails.
    expect(isError({ message: "looks like an error" })).toBe(false);
  });

  it("returns false for a number", () => {
    expect(isError(42)).toBe(false);
  });
});

describe("getErrorMessage", () => {
  it("returns the .message property when given an Error instance (branch 1)", () => {
    expect(getErrorMessage(new Error("something broke"))).toBe("something broke");
  });

  it("returns an empty string for an Error with an empty message", () => {
    expect(getErrorMessage(new Error(""))).toBe("");
  });

  it("returns the string directly when given a string (branch 2)", () => {
    expect(getErrorMessage("raw error string")).toBe("raw error string");
  });

  it("returns an empty string when given an empty string (branch 2 passthrough)", () => {
    expect(getErrorMessage("")).toBe("");
  });

  it("coerces a number to string via String() (branch 3)", () => {
    expect(getErrorMessage(42)).toBe("42");
  });

  it("coerces null to string via String() — produces 'null'", () => {
    expect(getErrorMessage(null)).toBe("null");
  });

  it("coerces undefined to string via String() — produces 'undefined'", () => {
    expect(getErrorMessage(undefined)).toBe("undefined");
  });

  it("coerces a plain object to string via String() — produces '[object Object]'", () => {
    expect(getErrorMessage({ code: 1 })).toBe("[object Object]");
  });
});

describe("extractErrorCode", () => {
  it("extracts a multi-word underscore code before the first colon", () => {
    // /^([A-Z_]+):/ matches "VAULT_REQUIRED" then ":" — returns capture group.
    expect(extractErrorCode(new Error("VAULT_REQUIRED: vault access missing"))).toBe(
      "VAULT_REQUIRED"
    );
  });

  it("extracts a single-uppercase-letter code", () => {
    // Regex [A-Z_]+ requires at least one character — single "A" satisfies it.
    expect(extractErrorCode(new Error("A: minimal prefix"))).toBe("A");
  });

  it("extracts a code with multiple underscore separators", () => {
    expect(
      extractErrorCode(new Error("TOKEN_EXPIRED_OR_INVALID: please re-authenticate"))
    ).toBe("TOKEN_EXPIRED_OR_INVALID");
  });

  it("returns null when the message has no colon-delimited uppercase prefix", () => {
    expect(extractErrorCode(new Error("plain error message with no code"))).toBe(null);
  });

  it("returns null when the prefix contains a lowercase letter (regex [A-Z_]+ does not match lowercase)", () => {
    // "Mixed" — 'M' matches [A-Z_], but 'i' does not, so the whole match fails.
    expect(extractErrorCode(new Error("Mixed_Case: not matched"))).toBe(null);
  });

  it("returns null when the message starts with ':' (empty capture group — [A-Z_]+ requires 1+ chars)", () => {
    expect(extractErrorCode(new Error(":no code before colon"))).toBe(null);
  });

  it("returns null when the error message is empty", () => {
    expect(extractErrorCode(new Error(""))).toBe(null);
  });

  it("returns null when given a string (not an Error instance — early return branch)", () => {
    // The guard `if (error instanceof Error)` fails for plain strings.
    expect(extractErrorCode("VAULT_REQUIRED: should not match")).toBe(null);
  });

  it("returns null when given null (non-Error early return)", () => {
    expect(extractErrorCode(null)).toBe(null);
  });

  it("returns null when given undefined (non-Error early return)", () => {
    expect(extractErrorCode(undefined)).toBe(null);
  });
});
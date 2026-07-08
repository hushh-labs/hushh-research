import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveLocalReviewerCredentials } from "@/lib/testing/local-reviewer-auth";

// Characterization tests for the local environment key-resolution path in
// lib/testing/local-reviewer-auth.ts, focused on how the resolver treats
// placeholder configuration markup vs. completely empty parameters.
//
// Truth-first note on the real implementation (verified against source):
//
//   resolveLocalReviewerCredentials() reads two env vars —
//   NEXT_PUBLIC_LOCAL_REVIEWER_EMAIL and NEXT_PUBLIC_LOCAL_REVIEWER_PASSWORD —
//   through a private sanitizeConfiguredValue() gate:
//
//     const trimmed = String(value || "").trim();
//     if (!trimmed) return "";
//     if (/replace_with_/i.test(trimmed)) return "";
//     if (/your_[a-z0-9_]+_here/i.test(trimmed)) return "";
//     return trimmed;
//
//   So there are TWO distinct "unhydrated" families that both collapse to "":
//     1. Empty / whitespace-only values.
//     2. Template placeholder markup: `replace_with_...` and `your_..._here`.
//
//   When EITHER credential resolves to "" (falsy), the function returns `null`
//   (`if (!email || !password) return null;`). It never throws on unhydrated
//   input — the failure mode is a safe `null`, not a crash.
//
//   A second, independent gate: even with fully hydrated credentials, a
//   non-local hostname (anything not in {localhost, 127.0.0.1}) also returns
//   `null`. An empty/undefined hostname skips that gate.
//
// These tests pin that ACTUAL contract rather than assuming a throw-based
// validation path.

const EMAIL_KEY = "NEXT_PUBLIC_LOCAL_REVIEWER_EMAIL";
const PASSWORD_KEY = "NEXT_PUBLIC_LOCAL_REVIEWER_PASSWORD";

let originalEmail: string | undefined;
let originalPassword: string | undefined;

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  originalEmail = process.env[EMAIL_KEY];
  originalPassword = process.env[PASSWORD_KEY];
});

afterEach(() => {
  setEnv(EMAIL_KEY, originalEmail);
  setEnv(PASSWORD_KEY, originalPassword);
});

describe("resolveLocalReviewerCredentials — environment key resolution fallbacks", () => {
  it("returns null (no crash) when both credentials are completely empty", () => {
    setEnv(EMAIL_KEY, "");
    setEnv(PASSWORD_KEY, "");
    expect(() => resolveLocalReviewerCredentials("localhost")).not.toThrow();
    expect(resolveLocalReviewerCredentials("localhost")).toBeNull();
  });

  it("returns null when the credentials are entirely unset (undefined)", () => {
    setEnv(EMAIL_KEY, undefined);
    setEnv(PASSWORD_KEY, undefined);
    expect(resolveLocalReviewerCredentials("localhost")).toBeNull();
  });

  it("drops `your_..._here` placeholder markup as unhydrated -> null", () => {
    setEnv(EMAIL_KEY, "your_reviewer_email_here");
    setEnv(PASSWORD_KEY, "your_reviewer_password_here");
    expect(resolveLocalReviewerCredentials("localhost")).toBeNull();
  });

  it("drops `replace_with_` placeholder markup as unhydrated -> null", () => {
    setEnv(EMAIL_KEY, "replace_with_real_email");
    setEnv(PASSWORD_KEY, "replace_with_real_password");
    expect(resolveLocalReviewerCredentials("localhost")).toBeNull();
  });

  it("returns null when only one side is hydrated (partial config)", () => {
    setEnv(EMAIL_KEY, "reviewer@example.com");
    setEnv(PASSWORD_KEY, "your_reviewer_password_here");
    expect(resolveLocalReviewerCredentials("localhost")).toBeNull();
  });

  it("resolves trimmed credentials when both are fully hydrated on a local host", () => {
    setEnv(EMAIL_KEY, "  reviewer@example.com  ");
    setEnv(PASSWORD_KEY, "  s3cret-pass  ");
    expect(resolveLocalReviewerCredentials("127.0.0.1")).toEqual({
      email: "reviewer@example.com",
      password: "s3cret-pass",
    });
  });

  it("returns null on a non-local hostname even with hydrated credentials", () => {
    setEnv(EMAIL_KEY, "reviewer@example.com");
    setEnv(PASSWORD_KEY, "s3cret-pass");
    expect(resolveLocalReviewerCredentials("app.hushh.ai")).toBeNull();
  });

  it("skips the host gate when hostname is empty/undefined (hydrated -> resolves)", () => {
    setEnv(EMAIL_KEY, "reviewer@example.com");
    setEnv(PASSWORD_KEY, "s3cret-pass");
    expect(resolveLocalReviewerCredentials()).toEqual({
      email: "reviewer@example.com",
      password: "s3cret-pass",
    });
  });
});

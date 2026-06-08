import { describe, expect, it } from "vitest";

import {
  redactObservabilityLog,
  redactObservabilityLogValue,
} from "@/lib/observability/log-redactor";
import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("observability log redactor", () => {
  it("redacts sensitive strings in diagnostic log messages", () => {
    const redacted = redactObservabilityLog(
      "user kai@example.com sent Bearer abcdefghijklmnopqrstuvwxyz123456 and vault_key_123"
    );

    expect(redacted).toContain("[REDACTED_EMAIL]");
    expect(redacted).toContain("Bearer [REDACTED_TOKEN]");
    expect(redacted).toContain("[REDACTED_VAULT_KEY]");
    expect(redacted).not.toContain("kai@example.com");
    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("does not coerce non-string diagnostic values", () => {
    const value = { droppedKeys: ["user_id"] };

    expect(redactObservabilityLogValue(value)).toBe(value);
  });

  it("keeps analytics payload sanitization owned by the schema", () => {
    const result = validateAndSanitizeEvent("auth_failed", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      action: "google",
      result: "error",
      user_email: "kai@example.com",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("user_email");
    expect(result.sanitized).not.toHaveProperty("user_email");
  });
});

// ── Parameter truncation mechanics ────────────────────────────────────────────
//
// redactObservabilityLog contains an implicit truncation mechanism:
// LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{32,}\b/g
//
// Any unbroken alphanumeric run of 32+ characters — regardless of how long
// that run is — is replaced with the constant 16-character placeholder
// "[REDACTED_SECRET]".  This means a 100 KB secret blob is compressed to 16
// chars in one pass, bounding the log-entry size for oversized inputs.
//
// The same bounding applies to BEARER tokens and VAULT keys embedded in large
// dumps.  Plain text that contains no matching patterns passes through at its
// original size, but the function must not throw or time-out on any input.
//
// Tests are limited to 100 KB payloads so CI stays well within regex timeout
// budgets while still proving the no-crash and size-reduction contracts.

describe("observability log redactor — parameter truncation mechanics", () => {
  // ── No-crash guarantee on massive plain-text ──────────────────────────────

  it("processes a 100 KB plain-text string without throwing (no-crash contract)", () => {
    // Space-separated words — no pattern matches, no secrets to redact.
    const massivePlainText = "word ".repeat(20_000); // 100 KB

    expect(() => redactObservabilityLog(massivePlainText)).not.toThrow();

    const output = redactObservabilityLog(massivePlainText);
    expect(typeof output).toBe("string");
    // Plain text with no sensitive tokens passes through at the same length.
    expect(output.length).toBe(massivePlainText.length);
  });

  // ── LONG_SECRET_PATTERN: massive secret → fixed-size placeholder ──────────

  it("compresses a 100 KB alphanumeric blob to a fixed-size placeholder (implicit truncation)", () => {
    // LONG_SECRET_PATTERN matches any 32+ char alphanumeric run.
    // A 100 000-char alphanumeric string is a single match → [REDACTED_SECRET].
    const massiveSecret = "a".repeat(100_000);

    const output = redactObservabilityLog(massiveSecret);

    expect(output).toBe("[REDACTED_SECRET]");
    // 16 chars instead of 100 000 — a 99.98% size reduction.
    expect(output.length).toBeLessThan(massiveSecret.length);
  });

  it("compresses a 500-character Bearer token to a fixed-size placeholder", () => {
    const longBearerToken = "Bearer " + "k".repeat(500);

    const output = redactObservabilityLog(longBearerToken);

    expect(output).toBe("Bearer [REDACTED_TOKEN]");
    expect(output.length).toBeLessThan(longBearerToken.length);
  });

  it("compresses a 200-character vault key to a fixed-size placeholder", () => {
    const longVaultKey = "vault_" + "x".repeat(200);

    const output = redactObservabilityLog(longVaultKey);

    expect(output).toBe("[REDACTED_VAULT_KEY]");
    expect(output.length).toBeLessThan(longVaultKey.length);
  });

  // ── Simulated exception dump ───────────────────────────────────────────────

  it("processes a simulated 100 KB unhandled-exception dump without crashing and redacts all embedded secrets", () => {
    // Realistic shape: email, vault key, bearer token, then a massive stack trace.
    const stackLine = "    at Object.processRequest (/app/dist/server.js:123:45)\n";
    const exceptionDump = [
      "Error: Unhandled exception in request handler",
      "user: crash@example.com",
      `session_vault: vault_${"x".repeat(64)}`,
      `Authorization: Bearer ${"z".repeat(256)}`,
      stackLine.repeat(1_500), // ~90 KB of stack frames
    ].join("\n");

    expect(() => redactObservabilityLog(exceptionDump)).not.toThrow();

    const output = redactObservabilityLog(exceptionDump);

    expect(typeof output).toBe("string");
    // All embedded secrets must be scrubbed.
    expect(output).not.toContain("crash@example.com");
    expect(output).not.toContain("vault_" + "x".repeat(64));
    expect(output).not.toContain("Bearer " + "z".repeat(256));
    // Non-sensitive lines pass through intact.
    expect(output).toContain("Unhandled exception in request handler");
    expect(output).toContain("at Object.processRequest");
  });

  // ── Bulk-secret payload: total size reduction ─────────────────────────────

  it("reduces the total size of a payload containing 100 embedded long secrets", () => {
    // Each 64-char secret is replaced by [REDACTED_SECRET] (16 chars).
    // 100 secrets × 48-char reduction = ~4 800-char reduction.
    const payloadLines = Array.from({ length: 100 }, (_, i) =>
      `key_${i}: ${"s".repeat(64)}`
    );
    const payload = payloadLines.join("\n");

    const output = redactObservabilityLog(payload);

    expect(output.length).toBeLessThan(payload.length);
    // No raw 64-char secret block should survive in the output.
    expect(output).not.toMatch(/s{64}/);
    expect(output).toContain("[REDACTED_SECRET]");
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("returns empty string for empty string input without throwing", () => {
    expect(() => redactObservabilityLog("")).not.toThrow();
    expect(redactObservabilityLog("")).toBe("");
  });

  it("returns whitespace-only strings unchanged (no matching patterns)", () => {
    expect(redactObservabilityLog("   \t\n  ")).toBe("   \t\n  ");
  });

  it("handles a 10 000-char whitespace string without throwing", () => {
    const massiveWhitespace = " ".repeat(10_000);
    expect(() => redactObservabilityLog(massiveWhitespace)).not.toThrow();
    expect(redactObservabilityLog(massiveWhitespace)).toBe(massiveWhitespace);
  });

  // ── redactObservabilityLogValue: non-string oversized payloads ────────────

  it("passes a large object through without modification or crash", () => {
    const bigObject = Object.fromEntries(
      Array.from({ length: 1_000 }, (_, i) => [`key_${i}`, `value_${i}`])
    );
    expect(redactObservabilityLogValue(bigObject)).toBe(bigObject);
  });

  it("passes a large array through without modification or crash", () => {
    const bigArray = new Array(5_000).fill({ secret: "s".repeat(64) });
    // Non-string values are returned as-is — the function never iterates
    // into object/array structures, so no throw and no mutation.
    expect(redactObservabilityLogValue(bigArray)).toBe(bigArray);
  });
});

// ── Tab-separated value handling ──────────────────────────────────────────────
//
// Log pipelines frequently emit TSV-structured entries where field values may
// carry PII (email addresses, vault keys).  The redactor must sanitize every
// sensitive token in-place regardless of surrounding tab delimiters, and must
// leave the tab characters themselves untouched so that downstream TSV parsers
// can still reconstruct the record structure correctly.
//
// Two contracts are verified:
//   1. Pattern matching fires correctly even when tabs surround a sensitive token.
//   2. Tab characters are never consumed, escaped, or shifted by a redaction pass.

describe("observability log redactor — tab-separated value handling", () => {
  it("redacts sensitive tokens inside a tab-delimited log entry while preserving all tab delimiters", () => {
    // Four-column TSV: timestamp \t email \t action \t vault_key
    // EMAIL_PATTERN domain clause [A-Z0-9.-]+ does not allow underscores,
    // so the domain is written without underscores to guarantee a match.
    const tsvLogLine = [
      "test_timestamp_001",
      "test_user@testorg.com",
      "test_action_read",
      "vault_test_org_key_001",
    ].join("\t");

    const redacted = redactObservabilityLog(tsvLogLine);

    // Sensitive tokens must be scrubbed regardless of surrounding tab delimiters.
    expect(redacted).not.toContain("test_user@testorg.com");
    expect(redacted).toContain("[REDACTED_EMAIL]");
    expect(redacted).not.toContain("vault_test_org_key_001");
    expect(redacted).toContain("[REDACTED_VAULT_KEY]");

    // Tab delimiters must survive intact — three delimiters for four fields.
    // If redaction consumed or shifted a tab, the downstream TSV parser would
    // produce a malformed record with the wrong column count.
    const tabCount = (redacted.match(/\t/g) ?? []).length;
    expect(tabCount).toBe(3);

    // Non-sensitive fields pass through unchanged.
    expect(redacted).toContain("test_timestamp_001");
    expect(redacted).toContain("test_action_read");
  });

  it("matches and redacts a sensitive token that immediately follows a tab without crashing", () => {
    // Validates that a word boundary after \t is correctly recognized so the
    // vault key is redacted even when no other text precedes it in the field.
    const tabEmbeddedValue = "user\tprofile\tdata\tvault_tab_test_key_002";

    const output = redactObservabilityLog(tabEmbeddedValue);

    // The vault key at the end of the tab-delimited string must be redacted.
    expect(output).not.toContain("vault_tab_test_key_002");
    expect(output).toContain("[REDACTED_VAULT_KEY]");

    // All three structural tab characters must be preserved.
    expect((output.match(/\t/g) ?? []).length).toBe(3);

    // Non-sensitive field content passes through unchanged.
    expect(output).toContain("user");
    expect(output).toContain("profile");
    expect(output).toContain("data");
  });
});

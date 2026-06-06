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

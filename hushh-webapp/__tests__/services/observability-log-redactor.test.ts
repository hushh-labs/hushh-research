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

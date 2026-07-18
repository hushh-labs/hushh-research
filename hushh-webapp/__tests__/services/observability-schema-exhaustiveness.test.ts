import { describe, expect, it } from "vitest";

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

const BASE_CONTEXT = {
  env: "uat",
  platform: "web",
  event_category: "system",
  app_version: "1.0.0",
} as const;

describe("observability schema contracts", () => {
  it("returns the documented result shape", () => {
    const result = validateAndSanitizeEvent(
      "page_view",
      BASE_CONTEXT as never,
    );

    expect(typeof result.ok).toBe("boolean");
    expect(typeof result.sanitized).toBe("object");
    expect(Array.isArray(result.droppedKeys)).toBe(true);
  });

  it("preserves base context keys during sanitization", () => {
    const { sanitized } = validateAndSanitizeEvent(
      "page_view",
      BASE_CONTEXT as never,
    );

    expect(sanitized.env).toBe("uat");
    expect(sanitized.platform).toBe("web");
    expect(sanitized.event_category).toBe("system");
    expect(sanitized.app_version).toBe("1.0.0");
  });

  it("drops user_id fields", () => {
    const result = validateAndSanitizeEvent(
      "page_view",
      {
        ...BASE_CONTEXT,
        user_id: "secret",
      } as never,
    );

    expect(result.droppedKeys).toContain("user_id");
  });

  it("drops email fields", () => {
    const result = validateAndSanitizeEvent(
      "page_view",
      {
        ...BASE_CONTEXT,
        user_email: "test@example.com",
      } as never,
    );

    expect(result.droppedKeys).toContain("user_email");
  });
});
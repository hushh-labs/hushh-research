import { describe, expect, it } from "vitest";

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("observability schema", () => {
  it("accepts metadata-only api payloads", () => {
    const result = validateAndSanitizeEvent("api_request_completed", {
      env: "uat",
      platform: "web",
      route_id: "kai_dashboard",
      endpoint_template: "/api/kai/analyze/run/start",
      http_method: "POST",
      result: "success",
      status_bucket: "2xx",
      duration_ms_bucket: "100ms_300ms",
      retry_count: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.sanitized.endpoint_template).toBe("/api/kai/analyze/run/start");
  });

  it("drops blocked keys and high-entropy sensitive values", () => {
    const result = validateAndSanitizeEvent(
      "auth_failed",
      {
        env: "uat",
        platform: "web",
        action: "google",
        result: "error",
        error_class: "auth_failed",
        // blocked key + value patterns (runtime guard)
        user_id: "abc123",
        token_hint: "template_token_hint_for_test_only",
      } as any
    );

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("user_id");
    expect(result.droppedKeys).toContain("token_hint");
    expect(result.sanitized.action).toBe("google");
    expect(result.sanitized.result).toBe("error");
  });

  it("accepts growth funnel payloads with the bounded growth params", () => {
    const result = validateAndSanitizeEvent("growth_funnel_step_completed", {
      env: "uat",
      platform: "web",
      journey: "investor",
      step: "portfolio_ready",
      entry_surface: "kai_import",
      auth_method: "google",
      portfolio_source: "statement",
      app_version: "2.1.0",
    });

    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.sanitized.journey).toBe("investor");
    expect(result.sanitized.step).toBe("portfolio_ready");
    expect(result.sanitized.entry_surface).toBe("kai_import");
  });
});

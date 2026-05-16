import { describe, expect, it } from "vitest";

import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("observability schema", () => {
  it("accepts metadata-only api payloads", () => {
    const result = validateAndSanitizeEvent("api_request_completed", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
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
        event_category: "system",
        app_version: "2.1.0",
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
      event_category: "funnel",
      app_version: "2.1.0",
      journey: "investor",
      step: "portfolio_ready",
      entry_surface: "kai_import",
      auth_method: "existing_session",
      portfolio_source: "statement",
    });

    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.sanitized.journey).toBe("investor");
    expect(result.sanitized.step).toBe("portfolio_ready");
    expect(result.sanitized.entry_surface).toBe("kai_import");
    expect(result.sanitized.auth_method).toBe("existing_session");
  });

  it("accepts governed feature events and preserves their category", () => {
    const result = validateAndSanitizeEvent("portfolio_viewed", {
      env: "uat",
      platform: "web",
      event_category: "feature",
      app_version: "2.1.0",
      result: "success",
      portfolio_source: "statement",
    });

    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.sanitized.event_category).toBe("feature");
    expect(result.sanitized.portfolio_source).toBe("statement");
  });

  it("accepts phone verification lifecycle metadata without phone values", () => {
    const result = validateAndSanitizeEvent("phone_verification_started", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      action: "link",
      result: "success",
      phone_number: "+16505550101",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("phone_number");
    expect(result.sanitized.action).toBe("link");
    expect(result.sanitized.result).toBe("success");
  });
});

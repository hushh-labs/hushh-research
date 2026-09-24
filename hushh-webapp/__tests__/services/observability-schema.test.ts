import { describe, expect, it } from "vitest";

import { ONE_LOCATION_JOURNEY_ACTIONS } from "@/lib/observability/events";
import { validateAndSanitizeEvent } from "@/lib/observability/schema";

describe("observability schema", () => {
  it.each([
    ["one_memory_action", "capture_saved", "pkm"],
    ["one_wallet_action", "card_added", "one_wallet"],
    ["one_calendar_action", "connected", "one_calendar"],
    ["one_kyc_action", "reply_sent", "one_kyc"],
    ["one_crm_action", "record_created", "connected_systems"],
  ] as const)("keeps only bounded %s feature action metadata", (eventName, action, routeId) => {
    const result = validateAndSanitizeEvent(eventName, {
      env: "production", platform: "ios", event_category: "feature",
      app_version: "1.1.0", route_id: routeId, action, result: "success",
      email: "person@example.test", wallet_token: "do-not-export",
      workflow_id: "do-not-export",
    } as any);
    expect(result.sanitized).toMatchObject({ route_id: routeId, action, result: "success" });
    expect(result.droppedKeys).toEqual(expect.arrayContaining(["email", "wallet_token", "workflow_id"]));
    expect(JSON.stringify(result.sanitized)).not.toContain("example.test");
  });
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

  it("preserves endpoint template sanitization", () => {
  const result = validateAndSanitizeEvent("api_request_completed", {
    env: "uat",
    platform: "web",
    event_category: "system",
    app_version: "2.1.0",
    route_id: "kai_dashboard",
    endpoint_template: "/api/consent/center",
    http_method: "GET",
    result: "success",
    status_bucket: "2xx",
    duration_ms_bucket: "0ms_100ms",
  });

  expect(result.ok).toBe(true);
  expect(result.sanitized.endpoint_template).toBe("/api/consent/center");
});

    it("preserves retry_count in sanitized observability payloads", () => {
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
    expect(result.sanitized.retry_count).toBe(0);
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

  it("accepts route cache performance metadata without user payloads", () => {
    const result = validateAndSanitizeEvent("route_readiness_completed", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      route_id: "kai_portfolio",
      result: "success",
      render_path: "secure_device_stale",
      cache_tier: "secure_device",
      resource_class: "financial_resource",
      duration_ms_bucket: "100ms_300ms",
      blocking_loader_shown: false,
      stale_rendered: true,
    });

    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual([]);
    expect(result.sanitized.render_path).toBe("secure_device_stale");
    expect(result.sanitized.cache_tier).toBe("secure_device");
  });

  it("accepts agent PKM reliability metadata without decrypted facts", () => {
    const result = validateAndSanitizeEvent("agent_pkm_context_resolved", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      route_id: "agent",
      result: "success",
      context_mode: "relevant",
      total_fact_count_bucket: "50_249",
      selected_fact_count_bucket: "10_49",
      context_clipped: false,
      inventory_only: false,
      safety_omitted: true,
      duration_ms_bucket: "300ms_1s",
      pkm_payload: "never send decrypted PKM facts to analytics",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("pkm_payload");
    expect(result.sanitized.context_mode).toBe("relevant");
    expect(result.sanitized.total_fact_count_bucket).toBe("50_249");
  });

  /**
   * The emergency alert is the most sensitive thing this product instruments.
   * It is worth measuring — an SOS that silently reaches nobody is the worst
   * bug we could ship — but only ever as counts. This test is the guard that
   * keeps a future "just add the message so we can debug it" from landing.
   */
  it("keeps the emergency SOS event to counts and drops the message, place and people", () => {
    const result = validateAndSanitizeEvent("one_location_sos_triggered", {
      env: "production",
      platform: "ios",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location",
      result: "error",
      selected_count: 3,
      reached_count: 0,
      unreachable_count: 3,
      has_note: true,
      // None of these may ever reach analytics.
      message: "I'm not safe, come get me",
      latitude: 37.7749,
      longitude: -122.4194,
      recipient_names: "Mom, Dad",
      phone: "+16505550101",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("message");
    expect(result.droppedKeys).toContain("latitude");
    expect(result.droppedKeys).toContain("longitude");
    expect(result.droppedKeys).toContain("recipient_names");
    expect(result.droppedKeys).toContain("phone");
    // The counts that make the alert falsifiable survive.
    expect(result.sanitized.selected_count).toBe(3);
    expect(result.sanitized.reached_count).toBe(0);
    expect(result.sanitized.has_note).toBe(true);
  });

  it("accepts the check-in and Circle events without naming the Circle", () => {
    const checkIn = validateAndSanitizeEvent("one_location_check_in_completed", {
      env: "production",
      platform: "ios",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location",
      result: "success",
      selected_count: 2,
      success_count: 2,
      failure_count: 0,
      circle_targeted: true,
    });
    expect(checkIn.ok).toBe(true);
    expect(checkIn.droppedKeys).toEqual([]);
    expect(checkIn.sanitized.circle_targeted).toBe(true);

    const checkOut = validateAndSanitizeEvent("one_location_check_out_completed", {
      env: "production",
      platform: "web",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location_check_in",
      result: "success",
    });
    expect(checkOut.ok).toBe(true);
    expect(checkOut.droppedKeys).toEqual([]);

    const unsafeCheckOut = validateAndSanitizeEvent("one_location_check_out_completed", {
      env: "production",
      platform: "web",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location_check_in",
      result: "success",
      place_name: "private venue",
      latitude: 37.4275,
    } as any);
    expect(unsafeCheckOut.ok).toBe(false);
    expect(unsafeCheckOut.droppedKeys).toEqual(expect.arrayContaining(["place_name", "latitude"]));

    const circle = validateAndSanitizeEvent("one_location_circle_created", {
      env: "production",
      platform: "web",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location",
      result: "success",
      circle_kind: "family",
      // A Circle name is the user's own words and routinely names a household.
      circle_name: "The Sharmas",
    } as any);
    expect(circle.ok).toBe(false);
    expect(circle.droppedKeys).toContain("circle_name");
    expect(circle.sanitized.circle_kind).toBe("family");

    const journey = validateAndSanitizeEvent("one_location_journey_action", {
      env: "production",
      platform: "ios",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "connect",
      action: "circle_member_invited",
      result: "success",
      entry_surface: "connect_circles",
      target_type: "circle",
      circle_kind: "friends",
      count_bucket: "2_3",
      circle_name: "Weekend trip",
      request_id: "request-secret",
      public_token: "share-secret",
    } as any);
    expect(journey.ok).toBe(false);
    expect(journey.droppedKeys).toEqual(
      expect.arrayContaining(["circle_name", "request_id", "public_token"]),
    );
    expect(journey.sanitized).toMatchObject({
      action: "circle_member_invited",
      entry_surface: "connect_circles",
      target_type: "circle",
      circle_kind: "friends",
      count_bucket: "2_3",
    });
  });

  it.each(ONE_LOCATION_JOURNEY_ACTIONS)(
    "preserves the governed One Location action %s",
    (action) => {
      const result = validateAndSanitizeEvent("one_location_journey_action", {
        env: "uat",
        platform: "web",
        event_category: "feature",
        app_version: "2.1.0",
        route_id: "one_location",
        action,
        result: "success",
        entry_surface: "location_hub",
        target_type: "person",
      });

      expect(result.ok).toBe(true);
      expect(result.droppedKeys).toEqual([]);
      expect(result.sanitized.action).toBe(action);
    },
  );

  it("still drops an undeclared opaque One Location action", () => {
    const result = validateAndSanitizeEvent("one_location_journey_action", {
      env: "uat",
      platform: "web",
      event_category: "feature",
      app_version: "2.1.0",
      route_id: "one_location",
      action: "opaque_runtime_action_4n6x8p2q7z",
      result: "success",
      entry_surface: "location_hub",
      target_type: "person",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("action");
    expect(result.sanitized.action).toBeUndefined();
  });

  it("drops sensitive fields from cache performance events", () => {
    const result = validateAndSanitizeEvent("cache_resource_resolved", {
      env: "uat",
      platform: "web",
      event_category: "system",
      app_version: "2.1.0",
      route_id: "one_kyc",
      result: "success",
      resource_class: "pkm_projection",
      cache_tier: "memory",
      freshness: "fresh",
      duration_ms_bucket: "lt_100ms",
      footprint_bucket: "50kb_250kb",
      user_id: "UWHGeUyfUAbmEl5xwIPoWJ7Cyft2",
      cache_key: "domain_data_UWHGeUyfUAbmEl5xwIPoWJ7Cyft2_financial",
      pkm_payload: "portfolio holdings should never be logged",
    } as any);

    expect(result.ok).toBe(false);
    expect(result.droppedKeys).toContain("user_id");
    expect(result.droppedKeys).toContain("cache_key");
    expect(result.droppedKeys).toContain("pkm_payload");
    expect(result.sanitized.resource_class).toBe("pkm_projection");
    expect(result.sanitized.freshness).toBe("fresh");
  });
});

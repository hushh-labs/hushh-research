import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
  shouldLoadWebAnalyticsScripts,
} from "@/lib/observability/env";
import { webGtmAdapter } from "@/lib/observability/adapters/web-gtm";
import { trackEvent } from "@/lib/observability/client";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: ReturnType<typeof vi.fn>;
  }
}

describe("web observability transport", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    window.dataLayer = [];
    window.gtag = vi.fn();
  });

  it("does not emit outbound web payloads when observability is disabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "0");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-2PCECPSKCR");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");

    trackEvent(
      "page_view",
      {
        route_id: "profile",
        nav_type: "initial_load",
        user_id: "firebase-user-123",
        email: "user@example.com",
        token_hint: "secret-token-value",
        phone_number: "+16505550101",
      } as any
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.dataLayer).toEqual([]);
    expect(window.gtag).not.toHaveBeenCalled();
  });

  // Wiring contract: the client forwards the schema-sanitized payload (plus the
  // standard env/platform/category/app_version context) to the web transport.
  // The field-level PII-drop guarantee itself is owned and exhaustively proven by
  // observability-schema.test.ts ("drops blocked keys and high-entropy sensitive
  // values", phone/user_id/token_hint cases); this asserts only that trackEvent
  // routes the already-sanitized result through to dataLayer/gtag unchanged.
  it("forwards the schema-sanitized payload through the production web transport", async () => {
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "1");
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-2PCECPSKCR");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");

    trackEvent("page_view", {
      route_id: "profile",
      nav_type: "route_change",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Exact-match assertion: only the sanitized metadata keys reach the transport.
    expect(window.dataLayer).toEqual([
      {
        event: "page_view",
        event_source: "observability_v2",
        env: "production",
        platform: "web",
        event_category: "system",
        app_version: "unknown",
        route_id: "profile",
        nav_type: "route_change",
      },
    ]);
    expect(window.gtag).toHaveBeenCalledWith("event", "page_view", {
      send_to: "G-2PCECPSKCR",
      event_source: "observability_v2",
      env: "production",
      platform: "web",
      event_category: "system",
      app_version: "unknown",
      route_id: "profile",
      nav_type: "route_change",
    });
  });

  it("ignores placeholder GTM and measurement IDs", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-UATPENDING1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "replace_with_uat_measurement_id");

    expect(resolveGtmContainerId()).toBe("");
    expect(resolveAnalyticsMeasurementId()).toBe("");
  });

  it("does not load remote analytics scripts during next dev by default", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");

    expect(shouldLoadWebAnalyticsScripts()).toBe(false);

    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_LOAD_IN_DEV", "1");
    expect(shouldLoadWebAnalyticsScripts()).toBe(true);
  });

  it("uses direct gtag delivery when GTM is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-UATPENDING1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");

    await webGtmAdapter.track("growth_funnel_step_completed", {
      env: "uat",
      platform: "web",
      event_category: "funnel",
      journey: "investor",
      step: "entered",
      app_version: "2.1.0",
    });

    expect(window.dataLayer).toEqual([
      {
        event: "growth_funnel_step_completed",
        event_source: "observability_v2",
        env: "uat",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        step: "entered",
        app_version: "2.1.0",
      },
    ]);
    expect(window.gtag).toHaveBeenCalledTimes(1);
    expect(window.gtag).toHaveBeenCalledWith(
      "event",
      "growth_funnel_step_completed",
      {
        send_to: "G-H1KGXGZTCF",
        event_source: "observability_v2",
        env: "uat",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        step: "entered",
        app_version: "2.1.0",
      }
    );
  });

  it("pushes to GTM and still sends direct GA4 when a real container is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-ABC1234");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-2PCECPSKCR");

    await webGtmAdapter.track("investor_activation_completed", {
      env: "production",
      platform: "web",
      event_category: "funnel",
      journey: "investor",
      portfolio_source: "statement",
      app_version: "2.1.0",
    });

    expect(window.dataLayer).toEqual([
      {
        event: "investor_activation_completed",
        event_source: "observability_v2",
        env: "production",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        portfolio_source: "statement",
        app_version: "2.1.0",
      },
    ]);
    expect(window.gtag).toHaveBeenCalledTimes(1);
    expect(window.gtag).toHaveBeenCalledWith(
      "event",
      "investor_activation_completed",
      {
        send_to: "G-2PCECPSKCR",
        event_source: "observability_v2",
        env: "production",
        platform: "web",
        event_category: "funnel",
        journey: "investor",
        portfolio_source: "statement",
        app_version: "2.1.0",
      }
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
} from "@/lib/observability/env";
import { webGtmAdapter } from "@/lib/observability/adapters/web-gtm";

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

  it("ignores placeholder GTM and measurement IDs", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-UATPENDING1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "replace_with_uat_measurement_id");

    expect(resolveGtmContainerId()).toBe("");
    expect(resolveAnalyticsMeasurementId()).toBe("");
  });

  it("uses direct gtag delivery when GTM is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "uat");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-UATPENDING1");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-H1KGXGZTCF");

    await webGtmAdapter.track("growth_funnel_step_completed", {
      env: "uat",
      platform: "web",
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
        event_source: "observability_v2",
        env: "uat",
        platform: "web",
        journey: "investor",
        step: "entered",
        app_version: "2.1.0",
      }
    );
  });

  it("keeps GTM as the owner when a real container is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-ABC1234");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-2PCECPSKCR");

    await webGtmAdapter.track("investor_activation_completed", {
      env: "production",
      platform: "web",
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
        journey: "investor",
        portfolio_source: "statement",
        app_version: "2.1.0",
      },
    ]);
    expect(window.gtag).not.toHaveBeenCalled();
  });
});

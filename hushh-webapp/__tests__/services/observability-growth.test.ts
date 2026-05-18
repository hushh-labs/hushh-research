import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import {
  captureGrowthAttribution,
  trackGrowthFunnelStepCompleted,
  trackInvestorActivationCompleted,
} from "@/lib/observability/growth";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

describe("growth observability contract", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "2.1.0");
    window.dataLayer = [];
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/login?redirect=%2Fkai&utm_source=growth");
  });

  it("preserves entry context and emits growth events in order through dataLayer", () => {
    captureGrowthAttribution("/login");

    trackGrowthFunnelStepCompleted({
      journey: "investor",
      step: "entered",
      entrySurface: "login",
      dedupeKey: "growth:investor:entered:test",
      dedupeWindowMs: 5_000,
    });

    trackGrowthFunnelStepCompleted({
      journey: "investor",
      step: "auth_completed",
      authMethod: "google",
      dedupeKey: "growth:investor:auth:test",
      dedupeWindowMs: 5_000,
    });

    trackInvestorActivationCompleted({
      portfolioSource: "statement",
      dedupeKey: "growth:investor:activation:test",
      dedupeWindowMs: 10_000,
    });

    expect(window.dataLayer).toHaveLength(3);
    expect(window.dataLayer?.map((entry) => entry.event)).toEqual([
      "growth_funnel_step_completed",
      "growth_funnel_step_completed",
      "investor_activation_completed",
    ]);

    const [entered, authed, activated] = window.dataLayer as Array<
      Record<string, unknown>
    >;

    expect(entered.event_source).toBe("observability_v2");
    expect(entered.event_category).toBe("funnel");
    expect(entered.entry_surface).toBe("login");
    expect(authed.event_category).toBe("funnel");
    expect(authed.auth_method).toBe("google");
    expect(authed.entry_surface).toBe("login");
    expect(activated.event_category).toBe("funnel");
    expect(activated.journey).toBe("investor");
    expect(activated.portfolio_source).toBe("statement");
    expect(activated.app_version).toBe("2.1.0");
  });
});

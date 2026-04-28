import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

import {
  resolveAnalyticsMeasurementId,
  resolveGtmContainerId,
} from "@/lib/observability/env";
import { trackPageView, trackApiRequestCompleted, trackEvent } from "@/lib/observability/client";
import {
  captureGrowthAttribution,
  trackGrowthFunnelStepCompleted,
  trackInvestorActivationCompleted,
  trackRiaActivationCompleted,
} from "@/lib/observability/growth";

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
    gtag?: ReturnType<typeof vi.fn>;
  }
}

interface TransportEntry {
  eventName: string;
  payload: Record<string, unknown>;
  atMs: number;
}

interface AuditRecord {
  scenario: string;
  eventName: string;
  dataLayerLatencyMs: number;
  gtagLatencyMs: number;
  callReturnLatencyMs: number;
  payload: Record<string, unknown>;
}

interface AuditArtifact {
  status: "pass";
  generatedAt: string;
  sandboxMode: "local_transport_only";
  measurementId: string;
  gtmContainerId: string;
  transportOwner: "direct_gtag";
  networkRequestsSent: 0;
  scenariosValidated: string[];
  eventsByName: Record<string, number>;
  dispatchLatencyMs: {
    count: number;
    dataLayer: LatencySummary;
    gtag: LatencySummary;
    callReturn: LatencySummary;
  };
  records: AuditRecord[];
}

interface LatencySummary {
  min: number;
  p50: number;
  p95: number;
  max: number;
}

const auditRecords: AuditRecord[] = [];
const dataLayerTransport: TransportEntry[] = [];
const gtagTransport: TransportEntry[] = [];

function roundLatency(value: number): number {
  return Number(value.toFixed(3));
}

function summarizeLatencies(values: number[]): LatencySummary {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (percentile: number) => {
    if (sorted.length === 0) return 0;
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)
    );
    return roundLatency(sorted[index] ?? 0);
  };
  return {
    min: roundLatency(sorted[0] ?? 0),
    p50: pick(50),
    p95: pick(95),
    max: roundLatency(sorted.at(-1) ?? 0),
  };
}

function installTransportSpies(): void {
  dataLayerTransport.length = 0;
  gtagTransport.length = 0;

  const dataLayer: Array<Record<string, unknown>> = [];
  const originalPush = dataLayer.push.bind(dataLayer);
  dataLayer.push = (...items: Record<string, unknown>[]) => {
    const atMs = performance.now();
    for (const item of items) {
      dataLayerTransport.push({
        eventName: String(item.event || ""),
        payload: item,
        atMs,
      });
    }
    return originalPush(...items);
  };
  window.dataLayer = dataLayer;

  window.gtag = vi.fn((command, eventName, payload) => {
    if (command !== "event") return;
    gtagTransport.push({
      eventName,
      payload: payload || {},
      atMs: performance.now(),
    });
  });
}

function resolveExpectedEventCategory(eventName: string): "funnel" | "feature" | "system" {
  if (
    eventName === "growth_funnel_step_completed" ||
    eventName === "investor_activation_completed" ||
    eventName === "ria_activation_completed"
  ) {
    return "funnel";
  }
  if (
    eventName === "portfolio_viewed" ||
    eventName === "recommendation_viewed" ||
    eventName === "marketplace_profile_viewed"
  ) {
    return "feature";
  }
  return "system";
}

function expectSharedPayloadContract(
  eventName: string,
  payload: Record<string, unknown>
): void {
  expect(payload.event_source).toBe("observability_v2");
  expect(payload.env).toBe("production");
  expect(payload.platform).toBe("web");
  expect(payload.event_category).toBe(resolveExpectedEventCategory(eventName));
  expect(payload.app_version).toBe("sandbox-audit");
}

function expectGrowthPayloadContract(
  eventName: string,
  payload: Record<string, unknown>
): void {
  expectSharedPayloadContract(eventName, payload);
  expect(payload.journey === "investor" || payload.journey === "ria").toBe(true);
  if (eventName === "growth_funnel_step_completed") {
    expect(typeof payload.step).toBe("string");
  }
}

async function recordScenario(
  scenario: string,
  expectedEventNames: string[],
  invoke: () => void
): Promise<void> {
  const beforeDataLayerCount = dataLayerTransport.length;
  const beforeGtagCount = gtagTransport.length;
  const startedAtMs = performance.now();
  invoke();
  const callReturnedAtMs = performance.now();
  await Promise.resolve();

  const newDataLayerEntries = dataLayerTransport.slice(beforeDataLayerCount);
  const newGtagEntries = gtagTransport.slice(beforeGtagCount);

  expect(newDataLayerEntries.map((entry) => entry.eventName)).toEqual(expectedEventNames);
  expect(newGtagEntries.map((entry) => entry.eventName)).toEqual(expectedEventNames);

  for (let index = 0; index < expectedEventNames.length; index += 1) {
    const eventName = expectedEventNames[index]!;
    const dataLayerEntry = newDataLayerEntries[index]!;
    const gtagEntry = newGtagEntries[index]!;

    expect(dataLayerEntry.eventName).toBe(gtagEntry.eventName);
    const { event: dataLayerEvent, ...sharedDataLayerPayload } = dataLayerEntry.payload;
    expect(dataLayerEvent).toBe(eventName);
    expect(gtagEntry.payload).toMatchObject({
      ...sharedDataLayerPayload,
      send_to: resolveAnalyticsMeasurementId(),
    });

    if (
      eventName === "growth_funnel_step_completed" ||
      eventName === "investor_activation_completed" ||
      eventName === "ria_activation_completed"
    ) {
      expectGrowthPayloadContract(eventName, dataLayerEntry.payload);
    } else {
      expectSharedPayloadContract(eventName, dataLayerEntry.payload);
    }

    auditRecords.push({
      scenario,
      eventName,
      dataLayerLatencyMs: roundLatency(dataLayerEntry.atMs - startedAtMs),
      gtagLatencyMs: roundLatency(gtagEntry.atMs - startedAtMs),
      callReturnLatencyMs: roundLatency(callReturnedAtMs - startedAtMs),
      payload: dataLayerEntry.payload,
    });
  }
}

function buildArtifact(): AuditArtifact {
  const eventsByName = auditRecords.reduce<Record<string, number>>((accumulator, record) => {
    accumulator[record.eventName] = (accumulator[record.eventName] || 0) + 1;
    return accumulator;
  }, {});

  return {
    status: "pass",
    generatedAt: new Date().toISOString(),
    sandboxMode: "local_transport_only",
    measurementId: resolveAnalyticsMeasurementId(),
    gtmContainerId: resolveGtmContainerId(),
    transportOwner: "direct_gtag",
    networkRequestsSent: 0,
    scenariosValidated: [...new Set(auditRecords.map((record) => record.scenario))],
    eventsByName,
    dispatchLatencyMs: {
      count: auditRecords.length,
      dataLayer: summarizeLatencies(auditRecords.map((record) => record.dataLayerLatencyMs)),
      gtag: summarizeLatencies(auditRecords.map((record) => record.gtagLatencyMs)),
      callReturn: summarizeLatencies(auditRecords.map((record) => record.callReturnLatencyMs)),
    },
    records: auditRecords,
  };
}

function persistArtifact(): void {
  const reportPath = process.env.OBSERVABILITY_SANDBOX_REPORT_JSON;
  if (!reportPath || auditRecords.length === 0) return;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(buildArtifact(), null, 2)}\n`, "utf-8");
}

describe("observability sandbox audit", () => {
  beforeEach(() => {
    auditRecords.length = 0;
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PUBLIC_APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_OBSERVABILITY_SAMPLE_RATE", "1");
    vi.stubEnv("NEXT_PUBLIC_GTM_ID", "GTM-PENDING-PROD");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID", "G-2PCECPSKCR");
    vi.stubEnv("NEXT_PUBLIC_CLIENT_VERSION", "sandbox-audit");
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/login?redirect=%2Fkai&utm_source=sandbox");
    installTransportSpies();
  });

  it("captures representative web observability journeys without hitting live analytics", async () => {
    captureGrowthAttribution("/login");

    await recordScenario("page_view_login", ["page_view"], () => {
      trackPageView("/login", "initial_load");
    });

    await recordScenario("investor_entered", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "investor",
        step: "entered",
        entrySurface: "login",
      });
    });

    await recordScenario("investor_auth_completed", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "investor",
        step: "auth_completed",
        authMethod: "google",
      });
    });

    await recordScenario("investor_vault_ready", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "investor",
        step: "vault_ready",
      });
    });

    await recordScenario("investor_onboarding_completed", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "investor",
        step: "onboarding_completed",
      });
    });

    await recordScenario("investor_portfolio_ready", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "investor",
        step: "portfolio_ready",
        portfolioSource: "statement",
      });
    });

    await recordScenario(
      "investor_activation",
      ["investor_activation_completed"],
      () => {
        trackInvestorActivationCompleted({
          portfolioSource: "statement",
        });
      }
    );

    await recordScenario("portfolio_viewed", ["portfolio_viewed"], () => {
      trackEvent("portfolio_viewed", {
        result: "success",
        portfolio_source: "statement",
      });
    });

    await recordScenario("recommendation_viewed", ["recommendation_viewed"], () => {
      trackEvent("recommendation_viewed", {
        result: "success",
        portfolio_source: "statement",
      });
    });

    await recordScenario("import_parse_completed", ["import_parse_completed"], () => {
      trackEvent("import_parse_completed", {
        result: "success",
      });
    });

    await recordScenario("import_quality_gate_passed", ["import_quality_gate_passed"], () => {
      trackEvent("import_quality_gate_passed", {
        result: "success",
      });
    });

    await recordScenario("import_save_completed", ["import_save_completed"], () => {
      trackEvent("import_save_completed", {
        result: "success",
      });
    });

    await recordScenario("phone_verification_started", ["phone_verification_started"], () => {
      trackEvent("phone_verification_started", {
        action: "link",
        result: "success",
      });
    });

    await recordScenario(
      "phone_verification_completed",
      ["phone_verification_completed"],
      () => {
        trackEvent("phone_verification_completed", {
          action: "link",
          result: "success",
        });
      }
    );

    window.history.replaceState({}, "", "/ria/onboarding?utm_source=sandbox");
    captureGrowthAttribution("/ria/onboarding");

    await recordScenario("ria_entered", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "entered",
        entrySurface: "ria_onboarding",
      });
    });

    await recordScenario("ria_auth_completed", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "auth_completed",
        authMethod: "google",
      });
    });

    await recordScenario("ria_profile_submitted", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "profile_submitted",
      });
    });

    await recordScenario("ria_request_created", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "request_created",
      });
    });

    await recordScenario("ria_workspace_ready", ["growth_funnel_step_completed"], () => {
      trackGrowthFunnelStepCompleted({
        journey: "ria",
        step: "workspace_ready",
        workspaceSource: "ria_client_workspace",
      });
    });

    await recordScenario(
      "ria_activation",
      ["ria_activation_completed"],
      () => {
        trackRiaActivationCompleted({
          workspaceSource: "ria_client_workspace",
        });
      }
    );

    await recordScenario("marketplace_profile_viewed", ["marketplace_profile_viewed"], () => {
      trackEvent("marketplace_profile_viewed", {
        action: "ria",
        result: "success",
      });
    });

    await recordScenario("api_request_contract", ["api_request_completed"], () => {
      trackApiRequestCompleted({
        path: "/api/kai/analyze/run/start",
        httpMethod: "POST",
        statusCode: 200,
        durationMs: 184,
        routeId: "kai_analysis",
        retryCount: 0,
      });
    });

    expect(resolveGtmContainerId()).toBe("");
    expect(resolveAnalyticsMeasurementId()).toBe("G-2PCECPSKCR");
    expect(window.gtag).toHaveBeenCalledTimes(auditRecords.length);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(auditRecords).toHaveLength(22);

    persistArtifact();
  });
});

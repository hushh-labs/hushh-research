import { deriveVoiceRouteScreen } from "@/lib/voice/route-screen-derivation";
import type { AppRuntimeState, VoiceActionResult, VoicePlanMode } from "@/lib/voice/voice-types";
import type { VoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

type RouteSnapshot = AppRuntimeState["route"];

type VoiceSettlementTelemetry = (
  event: string,
  payload?: Record<string, unknown>
) => void;

export type WaitForVoiceActionSettlementInput = {
  actionId?: string | null;
  mode?: VoicePlanMode;
  actionStatus?: VoiceActionResult["status"];
  routeBefore?: RouteSnapshot | null;
  expectedRoute?: string | null;
  expectedScreen?: string | null;
  getCurrentRoute: () => RouteSnapshot | undefined;
  getCurrentSurfaceMetadata?: () => VoiceSurfaceMetadata | null;
  emitTelemetry?: VoiceSettlementTelemetry;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeHref(value: string | null | undefined): string {
  return String(value || "").trim();
}

function stripQuery(href: string): string {
  const index = href.indexOf("?");
  return index >= 0 ? href.slice(0, index) : href;
}

function routeMatchesTarget(currentPath: string, expectedRoute: string): boolean {
  if (!currentPath || !expectedRoute) return false;
  if (expectedRoute.includes("?")) {
    return currentPath === expectedRoute;
  }
  return stripQuery(currentPath) === stripQuery(expectedRoute);
}

function hasMeaningfulSurfaceMetadata(surface: VoiceSurfaceMetadata | null | undefined): boolean {
  if (!surface) return false;
  return Boolean(
    surface.title ||
      surface.purpose ||
      (surface.sections && surface.sections.length > 0) ||
      (surface.controls && surface.controls.length > 0) ||
      (surface.actions && surface.actions.length > 0) ||
      (surface.visibleModules && surface.visibleModules.length > 0)
  );
}

function resolveExpectedScreen(
  expectedRoute: string | null | undefined,
  expectedScreen: string | null | undefined
): string | null {
  const normalizedScreen = String(expectedScreen || "").trim();
  if (normalizedScreen) return normalizedScreen;
  const normalizedRoute = normalizeHref(expectedRoute);
  if (!normalizedRoute) return null;
  return deriveVoiceRouteScreen(normalizedRoute).screen || null;
}

export async function waitForVoiceActionSettlement(
  input: WaitForVoiceActionSettlementInput
): Promise<Pick<VoiceActionResult, "route_after" | "screen_after" | "settled_by" | "data">> {
  const timeoutMs = input.timeoutMs ?? 1200;
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  const routeBefore = input.routeBefore || null;
  const expectedRoute = normalizeHref(input.expectedRoute);
  const expectedScreen = resolveExpectedScreen(expectedRoute, input.expectedScreen);
  const startedAt = Date.now();

  input.emitTelemetry?.("action_settlement_wait_started", {
    action_id: input.actionId || null,
    expected_route: expectedRoute || null,
    expected_screen: expectedScreen || null,
    action_status: input.actionStatus || null,
    mode: input.mode || null,
  });

  if (
    input.mode === "start_background_and_ack" &&
    !expectedRoute &&
    !expectedScreen &&
    (input.actionStatus === "started" || input.actionStatus === "succeeded")
  ) {
    const currentRoute = input.getCurrentRoute();
    input.emitTelemetry?.("action_settlement_succeeded", {
      action_id: input.actionId || null,
      settled_by: "background_start",
      route_after: currentRoute?.pathname || null,
      screen_after: currentRoute?.screen || null,
    });
    return {
      route_after: currentRoute?.pathname || null,
      screen_after: currentRoute?.screen || null,
      settled_by: "background_start",
    };
  }

  while (Date.now() - startedAt <= timeoutMs) {
    const currentRoute = input.getCurrentRoute();
    const currentPath = normalizeHref(currentRoute?.pathname);
    const currentScreen = String(currentRoute?.screen || "").trim() || null;
    const currentSurface = input.getCurrentSurfaceMetadata?.() || null;
    const routeChanged = Boolean(
      currentPath &&
        (
          expectedRoute
            ? routeMatchesTarget(currentPath, expectedRoute)
            : currentPath !== normalizeHref(routeBefore?.pathname)
        )
    );
    const screenMatches = Boolean(
      expectedScreen
        ? currentScreen === expectedScreen
        : currentScreen && currentScreen !== String(routeBefore?.screen || "").trim()
    );
    const surfaceScreen = String(currentSurface?.screenId || "").trim() || null;
    const surfaceMatches = Boolean(
      hasMeaningfulSurfaceMetadata(currentSurface) &&
        (expectedScreen ? surfaceScreen === expectedScreen : surfaceScreen === currentScreen)
    );

    if (routeChanged && (screenMatches || surfaceMatches || !expectedScreen)) {
      const settledBy =
        input.mode === "start_background_and_ack"
          ? "background_start"
          : surfaceMatches || screenMatches
            ? "screen"
            : "route";
      input.emitTelemetry?.("action_settlement_succeeded", {
        action_id: input.actionId || null,
        settled_by: settledBy,
        route_after: currentPath || null,
        screen_after: currentScreen,
      });
      return {
        route_after: currentPath || null,
        screen_after: surfaceMatches ? surfaceScreen : currentScreen,
        settled_by: settledBy,
        data: surfaceMatches
          ? {
              surface_title: currentSurface?.title || null,
              surface_purpose: currentSurface?.purpose || null,
            }
          : undefined,
      };
    }

    await sleep(pollIntervalMs);
  }

  const timedOutRoute = input.getCurrentRoute();
  const timedOutSurface = input.getCurrentSurfaceMetadata?.() || null;
  input.emitTelemetry?.("action_settlement_timed_out", {
    action_id: input.actionId || null,
    expected_route: expectedRoute || null,
    expected_screen: expectedScreen || null,
    route_after: timedOutRoute?.pathname || null,
    screen_after: timedOutRoute?.screen || null,
  });
  return {
    route_after: timedOutRoute?.pathname || null,
    screen_after: timedOutRoute?.screen || null,
    settled_by: "timeout",
    data: hasMeaningfulSurfaceMetadata(timedOutSurface)
      ? {
          surface_title: timedOutSurface?.title || null,
          surface_purpose: timedOutSurface?.purpose || null,
        }
      : undefined,
  };
}

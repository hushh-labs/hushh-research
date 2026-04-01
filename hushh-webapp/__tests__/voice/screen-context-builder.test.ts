import { beforeEach, describe, expect, it } from "vitest";

import { buildStructuredScreenContext } from "@/lib/voice/screen-context-builder";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

function makeRuntimeState(pathname: string, screen: string): AppRuntimeState {
  return {
    auth: {
      signed_in: true,
      user_id: "user_1",
    },
    vault: {
      unlocked: true,
      token_available: true,
      token_valid: true,
    },
    route: {
      pathname,
      screen,
      subview: null,
    },
    runtime: {
      analysis_active: false,
      analysis_ticker: null,
      analysis_run_id: null,
      import_active: false,
      import_run_id: null,
      busy_operations: [],
    },
    portfolio: {
      has_portfolio_data: true,
    },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
  };
}

describe("buildStructuredScreenContext", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    window.history.pushState({}, "", "/");
  });

  it("derives route-aware tab/section context across transitions", () => {
    window.history.pushState({}, "", "/kai/portfolio?tab=overview&section=allocation");
    document.body.innerHTML = "<h1>Portfolio</h1>";
    const dashboardContext = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai/portfolio", "dashboard"),
      voiceContext: {
        active_tab: "overview",
        selected_entity: "AAPL",
      },
    });

    expect(dashboardContext.route.pathname).toBe("/kai/portfolio");
    expect(dashboardContext.route.screen).toBe("dashboard");
    expect(dashboardContext.ui.active_tab).toBe("overview");
    expect(dashboardContext.ui.active_section).toBe("allocation");
    expect(dashboardContext.ui.selected_entity).toBe("AAPL");

    window.history.pushState({}, "", "/kai/analysis?tab=history&section=history");
    document.body.innerHTML = "<h1>Analysis</h1>";
    const analysisContext = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/kai/analysis", "analysis"),
      voiceContext: {},
    });

    expect(analysisContext.route.pathname).toBe("/kai/analysis");
    expect(analysisContext.route.screen).toBe("analysis");
    expect(analysisContext.ui.active_tab).toBe("history");
    expect(analysisContext.ui.active_section).toBe("history");
  });

  it("collects visible modules from DOM attributes", () => {
    window.history.pushState({}, "", "/profile?tab=account");
    document.body.innerHTML = `
      <h1>Profile Settings</h1>
      <section data-voice-module="Support Panel"></section>
      <div data-card-name="Gmail Connector"></div>
      <div role="region" aria-label="Session Controls"></div>
    `;

    const context = buildStructuredScreenContext({
      appRuntimeState: makeRuntimeState("/profile", "profile"),
      voiceContext: {},
    });

    expect(context.route.page_title).toBe("Profile Settings");
    expect(context.ui.visible_modules).toEqual(
      expect.arrayContaining(["Support Panel", "Gmail Connector", "Session Controls"])
    );
  });
});

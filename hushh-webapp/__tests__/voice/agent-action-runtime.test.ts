import { describe, expect, it, vi } from "vitest";

import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { ROUTES } from "@/lib/navigation/routes";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

function runtimeState(overrides: Partial<AppRuntimeState> = {}): AppRuntimeState {
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
      pathname: "/agent",
      screen: "app",
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
    persona: {
      active: "investor",
      primary_nav: "investor",
      available: ["investor"],
      transition_target: null,
      ria_switch_available: false,
      ria_setup_available: false,
    },
    voice: {
      available: true,
      tts_playing: false,
      last_tool_name: null,
      last_ticker: null,
    },
    ...overrides,
  };
}

describe("executeAgentGatewayAction", () => {
  it("routes Agent analysis.start tools to the comparison preview before debate launch", async () => {
    const router = {
      push: vi.fn(),
    };
    const setAnalysisParams = vi.fn();

    const result = await executeAgentGatewayAction({
      actionId: "analysis.start",
      slots: {
        symbol: "nvda",
      },
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams,
    });

    expect(setAnalysisParams).toHaveBeenCalledWith(null);
    expect(router.push).toHaveBeenCalledWith(`${ROUTES.KAI_ANALYSIS}?ticker=NVDA`);
    expect(result).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: `${ROUTES.KAI_ANALYSIS}?ticker=NVDA`,
      screenAfter: "kai_analysis",
      resultSummary: "Opened the NVDA comparison preview before starting the debate.",
    });
  });

  it("syncs to the investor workspace before running direct finance actions from RIA", async () => {
    const router = {
      push: vi.fn(),
    };
    const setAnalysisParams = vi.fn();
    const switchPersona = vi.fn(async () => null);

    const result = await executeAgentGatewayAction({
      actionId: "analysis.start",
      slots: {
        symbol: "tsla",
      },
      userId: "user_1",
      router,
      appRuntimeState: runtimeState({
        persona: {
          active: "ria",
          primary_nav: "ria",
          available: ["ria", "investor"],
          transition_target: null,
          ria_switch_available: true,
          ria_setup_available: false,
        },
      }),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams,
      switchPersona,
    });

    expect(switchPersona).toHaveBeenCalledWith("investor");
    expect(router.push).toHaveBeenCalledWith(`${ROUTES.KAI_ANALYSIS}?ticker=TSLA`);
    expect(result).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: `${ROUTES.KAI_ANALYSIS}?ticker=TSLA`,
      screenAfter: "kai_analysis",
    });
  });
});

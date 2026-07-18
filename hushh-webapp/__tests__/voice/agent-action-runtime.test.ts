import { describe, expect, it, vi } from "vitest";

import {
  executeAgentGatewayAction,
  executeTrustedActivationGatewayAction,
} from "@/lib/agent/agent-action-runtime";
import {
  registerLocalOnboardingHandler,
  unregisterLocalOnboardingHandler,
} from "@/lib/agent/local-onboarding-actions";
import { buildKaiMarketRoute, ROUTES } from "@/lib/navigation/routes";
import type { AppRuntimeState } from "@/lib/voice/voice-types";

function runtimeState(
  overrides: Partial<AppRuntimeState> = {},
): AppRuntimeState {
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
  it("admits generated direct route actions outside the current screen inventory", async () => {
    const router = { push: vi.fn() };

    const result = await executeAgentGatewayAction({
      actionId: "route.one_location",
      allowedActionIds: [],
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams: vi.fn(),
    });

    expect(router.push).toHaveBeenCalledWith(ROUTES.ONE_LOCATION);
    expect(result).toMatchObject({
      status: "started",
      actionId: "route.one_location",
      routeAfter: ROUTES.ONE_LOCATION,
    });
  });

  it("keeps global route actions blocked behind an active blocking layer", async () => {
    const router = { push: vi.fn() };

    const result = await executeAgentGatewayAction({
      actionId: "route.one_location",
      allowedActionIds: [],
      surfaceMetadata: {
        interactionLayer: {
          schemaVersion: "voice_interaction_layer.v1",
          id: "vault-unlock",
          kind: "vault",
          modality: "blocking",
          lifecycle: "open",
          dismissible: false,
          visibleActionIds: [],
          visibleControlIds: [],
          options: [],
          blocksUnderlyingActions: true,
          agentContinuity: "suppressed",
        },
      },
      userId: "user_1",
      router,
      appRuntimeState: runtimeState(),
      hasPortfolioData: true,
      busyOperations: {},
      setAnalysisParams: vi.fn(),
    });

    expect(router.push).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "blocked",
      actionId: "route.one_location",
      reason: "action_not_in_active_inventory",
    });
  });

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
    expect(router.push).toHaveBeenCalledWith(
      buildKaiMarketRoute("analysis", { ticker: "NVDA" }),
    );
    expect(result).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: buildKaiMarketRoute("analysis", { ticker: "NVDA" }),
      screenAfter: "kai_analysis",
      resultSummary:
        "Opened the NVDA comparison preview before starting the debate.",
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
    expect(router.push).toHaveBeenCalledWith(
      buildKaiMarketRoute("analysis", { ticker: "TSLA" }),
    );
    expect(result).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: buildKaiMarketRoute("analysis", { ticker: "TSLA" }),
      screenAfter: "kai_analysis",
    });
  });

  it("forwards directive correlation to provider local handlers without placing it in slots", async () => {
    const router = { push: vi.fn() };
    const handler = vi.fn().mockResolvedValue({
      status: "started",
      summary: "Google sign-in is opening.",
    });
    registerLocalOnboardingHandler("auth.sign_in_google", handler);

    try {
      const result = await executeAgentGatewayAction({
        actionId: "auth.sign_in_google",
        slots: {},
        executionContext: { directiveId: "directive-123" },
        userId: "user_1",
        router,
        appRuntimeState: runtimeState({
          route: { pathname: "/login", screen: "login", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      expect(handler).toHaveBeenCalledWith(
        {},
        { directiveId: "directive-123" },
      );
      expect(result).toMatchObject({
        status: "started",
        actionId: "auth.sign_in_google",
      });
    } finally {
      unregisterLocalOnboardingHandler("auth.sign_in_google", handler);
    }
  });

  it("invokes a trusted provider handler synchronously from the confirming tap", async () => {
    const router = { push: vi.fn() };
    let invoked = false;
    let settle:
      ((value: { status: "started"; summary: string }) => void) | null = null;
    const handler = vi.fn(() => {
      invoked = true;
      return new Promise<{ status: "started"; summary: string }>((resolve) => {
        settle = resolve;
      });
    });
    registerLocalOnboardingHandler("auth.sign_in_apple", handler);

    try {
      const resultPromise = executeTrustedActivationGatewayAction({
        actionId: "auth.sign_in_apple",
        slots: {},
        executionContext: { directiveId: "directive-apple" },
        userId: "",
        router,
        appRuntimeState: runtimeState({
          auth: { signed_in: false, user_id: null },
          vault: {
            unlocked: false,
            token_available: false,
            token_valid: false,
          },
          route: { pathname: "/login", screen: "login", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      expect(invoked).toBe(true);
      settle?.({ status: "started", summary: "Apple popup opened." });
      await expect(resultPromise).resolves.toMatchObject({
        status: "started",
        actionId: "auth.sign_in_apple",
      });
    } finally {
      unregisterLocalOnboardingHandler("auth.sign_in_apple", handler);
    }
  });

  it("settles the root claim action through its local handler", async () => {
    const router = { push: vi.fn() };
    const handler = vi.fn().mockResolvedValue({
      status: "started",
      summary: "Opening sign-in.",
    });
    registerLocalOnboardingHandler("onboarding.claim_one", handler);

    try {
      const result = await executeAgentGatewayAction({
        actionId: "onboarding.claim_one",
        slots: {},
        userId: "",
        router,
        appRuntimeState: runtimeState({
          auth: { signed_in: false, user_id: null },
          vault: {
            unlocked: false,
            token_available: false,
            token_valid: false,
          },
          route: { pathname: "/", screen: "one_intro", subview: null },
        }),
        hasPortfolioData: false,
        busyOperations: {},
        setAnalysisParams: vi.fn(),
      });

      expect(handler).toHaveBeenCalledWith({}, undefined);
      expect(result).toMatchObject({
        status: "started",
        actionId: "onboarding.claim_one",
        resultSummary: "Opening sign-in.",
      });
    } finally {
      unregisterLocalOnboardingHandler("onboarding.claim_one", handler);
    }
  });
});

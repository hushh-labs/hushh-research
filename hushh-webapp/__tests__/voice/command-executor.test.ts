import { beforeEach, describe, expect, it, vi } from "vitest";

const toastInfoMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    info: (...args: unknown[]) => toastInfoMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import { executeKaiCommand } from "@/lib/kai/command-executor";

function baseInput() {
  return {
    router: {
      push: vi.fn(),
    },
    userId: "user_1",
    hasPortfolioData: true,
    reviewDirty: false,
    busyOperations: {} as Record<string, boolean>,
    setAnalysisParams: vi.fn(),
    currentRoute: "/profile",
    currentScreen: "profile_account",
  };
}

describe("executeKaiCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the comparison preview for voice analyze commands", () => {
    const input = baseInput();

    const result = executeKaiCommand({
      ...input,
      command: "analyze",
      params: {
        symbol: "nvda",
      },
    });

    expect(input.setAnalysisParams).toHaveBeenCalledWith(null);
    expect(input.router.push).toHaveBeenCalledWith("/kai/analysis?ticker=NVDA");
    expect(result).toEqual({
      status: "executed",
      reason: undefined,
      actionResult: {
        status: "started",
        actionId: "analysis.start",
        routeBefore: "/profile",
        routeAfter: "/kai/analysis?ticker=NVDA",
        screenBefore: "profile_account",
        screenAfter: "kai_analysis",
        resultSummary: "Opened the NVDA comparison preview before starting the debate.",
        data: {
          command: "analyze",
          symbol: "NVDA",
        },
      },
    });
  });

  it("opens the active analysis route when a run is already active", () => {
    const input = baseInput();

    const result = executeKaiCommand({
      ...input,
      command: "analyze",
      params: {
        symbol: "msft",
      },
      busyOperations: {
        stock_analysis_active: true,
      },
    });

    expect(toastErrorMock).toHaveBeenCalledWith("A debate is already running.", {
      description: "Open analysis to continue with the active run.",
    });
    expect(input.router.push).toHaveBeenCalledWith("/kai/analysis?focus=active&ticker=MSFT");
    expect(result.actionResult.routeAfter).toBe("/kai/analysis?focus=active&ticker=MSFT");
    expect(result.actionResult.screenAfter).toBe("kai_analysis");
  });

  it("opens preview even when portfolio data has not been imported yet", () => {
    const input = baseInput();

    const result = executeKaiCommand({
      ...input,
      hasPortfolioData: false,
      command: "analyze",
      params: {
        symbol: "amd",
      },
    });

    expect(input.setAnalysisParams).toHaveBeenCalledWith(null);
    expect(input.router.push).toHaveBeenCalledWith("/kai/analysis?ticker=AMD");
    expect(result.actionResult).toMatchObject({
      status: "started",
      actionId: "analysis.start",
      routeAfter: "/kai/analysis?ticker=AMD",
      screenAfter: "kai_analysis",
    });
  });

  it("opens analysis history even when portfolio data has not been imported yet", () => {
    const input = baseInput();

    const result = executeKaiCommand({
      ...input,
      hasPortfolioData: false,
      command: "history",
    });

    expect(input.router.push).toHaveBeenCalledWith("/kai/analysis?tab=history");
    expect(result.actionResult).toMatchObject({
      status: "succeeded",
      actionId: "route.analysis_history",
      routeAfter: "/kai/analysis?tab=history",
      screenAfter: "kai_analysis",
    });
  });
});

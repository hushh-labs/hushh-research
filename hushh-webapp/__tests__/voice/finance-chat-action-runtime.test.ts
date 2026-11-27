import { describe, expect, it, vi } from "vitest";
import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { registerLocalOnboardingHandler, unregisterLocalOnboardingHandler } from "@/lib/agent/local-onboarding-actions";
import { runtimeState } from "./agent-action-runtime-fixture";

describe("Finance confirmation in chat", () => {
  it("admits confirmed stock analysis only on an eligible live chat card", async () => {
    const handler = vi.fn(async (_slots, context) =>
      context?.humanConfirmationToken === "visible-tap"
        ? { status: "succeeded" as const, summary: "Started" }
        : { status: "blocked" as const, summary: "Confirm first" });
    registerLocalOnboardingHandler("analysis.confirm_preview", handler);
    const common = {
      actionId: "analysis.confirm_preview", userId: "user_1", router: { push: vi.fn() },
      hasPortfolioData: true, busyOperations: {}, setAnalysisParams: vi.fn(),
      surfaceMetadata: { actions: [{ id: "analysis.confirm_preview", actionId: "analysis.confirm_preview", label: "Start" }] },
    };
    try {
      const hidden = await executeAgentGatewayAction({ ...common, allowedActionIds: [], appRuntimeState: runtimeState() });
      expect(hidden.status).toBe("blocked");
      const advisor = await executeAgentGatewayAction({ ...common, appRuntimeState: runtimeState({
        persona: { active: "ria", primary_nav: "ria", available: ["ria"], ria_switch_available: true, ria_setup_available: false },
      }) });
      expect(advisor.status).toBe("blocked");
      const busy = await executeAgentGatewayAction({ ...common, appRuntimeState: runtimeState({
        runtime: { analysis_active: true, analysis_ticker: "NVDA", analysis_run_id: "other", import_active: false, import_run_id: null, busy_operations: [] },
      }) });
      expect(busy.status).toBe("blocked");
      expect(handler).not.toHaveBeenCalled();
      const result = await executeAgentGatewayAction({ ...common, appRuntimeState: runtimeState(),
        executionContext: { humanConfirmationToken: "visible-tap" } });
      expect(result.status).toBe("succeeded");
      expect(handler).toHaveBeenCalledTimes(1);
      expect(common.router.push).not.toHaveBeenCalled();
    } finally {
      unregisterLocalOnboardingHandler("analysis.confirm_preview", handler);
    }
  });
});

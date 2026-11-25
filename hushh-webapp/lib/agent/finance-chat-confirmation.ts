import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { appInteractionCoordinator } from "@/lib/interaction/interaction-intent-coordinator";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

type ConfirmationContext = Pick<Parameters<typeof executeAgentGatewayAction>[0],
  "userId" | "router" | "appRuntimeState" | "surfaceMetadata" | "hasPortfolioData" |
  "busyOperations" | "setAnalysisParams" | "switchPersona">;

export async function executeConfirmedFinanceAnalysis(confirmation: string, context: ConfirmationContext) {
  const actionId = "analysis.confirm_preview";
  const actionRun = appInteractionCoordinator.startActionRun({
    actionId, label: "Start analysis debate", source: "search", directiveId: null,
  });
  try {
    appInteractionCoordinator.updateActionRun(actionRun.id, { phase: "executing" });
    const result = await executeAgentGatewayAction({
      ...context,
      actionId,
      executionContext: { humanConfirmationToken: confirmation, confirmedAt: new Date().toISOString() },
    });
    appInteractionCoordinator.finishActionRunFromSettlement(actionRun.id, {
      status: result.status, summary: result.resultSummary, reason: result.reason,
      routeAfter: result.routeAfter, screenAfter: result.screenAfter,
    });
    if (result.status === "blocked" || result.status === "failed" || result.status === "invalid") {
      toast.error(result.resultSummary);
    }
  } catch {
    appInteractionCoordinator.updateActionRun(actionRun.id, { phase: "failed", message: "Analysis could not start." });
    toast.error("Analysis could not start.");
  }
}

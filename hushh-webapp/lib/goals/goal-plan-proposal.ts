import { goalInput, goalStepTitles, isGoalRecord } from "./goal-model";
import type { GoalPlanInput } from "@/lib/services/goals-pkm-service";

/** Admit editable plan fields only from a typed tool result. */
export function readGoalPlanProposal(result: unknown): GoalPlanInput | null {
  if (typeof result === "string" && result.length <= 32_000) {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (!isGoalRecord(result) || result.status !== "proposal_ready" || result.type !== "goals.plan" ||
    typeof result.title !== "string" || typeof result.outcome !== "string" ||
    !(result.category === null || typeof result.category === "string")) return null;
  try {
    return {
      ...goalInput({ title: result.title, outcome: result.outcome, category: result.category }),
      steps: goalStepTitles(result.steps),
      taskIds: [],
    };
  } catch {
    return null;
  }
}

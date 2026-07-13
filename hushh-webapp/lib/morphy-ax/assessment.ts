import type {
  MorphyAxAssessmentDecision,
  MorphyAxAssessmentV1,
  MorphyAxSnapshotV1,
} from "./types";

/**
 * Apply repeatable policy to an intelligence-produced assessment.
 * This validator never infers meaning or substitutes a different action.
 */
export function validateMorphyAxAssessment(
  assessment: MorphyAxAssessmentV1,
  snapshot: MorphyAxSnapshotV1,
): MorphyAxAssessmentDecision {
  if (
    !Number.isFinite(assessment.confidence) ||
    assessment.confidence < 0 ||
    assessment.confidence > 1
  ) {
    return { status: "rejected", reason: "invalid_confidence" };
  }
  if (
    assessment.ambiguous ||
    assessment.disposition === "ask_clarifying_question"
  ) {
    return {
      status: "clarify",
      reason: assessment.missing_input || "ambiguous_intent",
    };
  }
  if (
    assessment.disposition !== "execute_visible_action" &&
    assessment.disposition !== "confirm_visible_action"
  ) {
    return { status: "conversation", disposition: assessment.disposition };
  }
  const actionId = assessment.candidate_action_id?.trim();
  if (!actionId) return { status: "clarify", reason: "missing_action" };
  if (snapshot.orchestration.pending_settlement) {
    return { status: "rejected", reason: "settlement_pending" };
  }
  if (!snapshot.tools.available_action_ids.includes(actionId)) {
    return { status: "rejected", reason: "action_not_available_on_screen" };
  }
  if (assessment.disposition === "confirm_visible_action") {
    return { status: "confirmation_required", action_id: actionId };
  }
  return { status: "permitted", action_id: actionId };
}

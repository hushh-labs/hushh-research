/** Copy the decision envelope without mutating the streamed analysis. */
export function buildDecisionHistoryRawCard(
  payload: Record<string, unknown>,
  runId: string,
): Record<string, unknown> {
  const rawCard: Record<string, unknown> =
    payload.raw_card && typeof payload.raw_card === "object"
      ? { ...(payload.raw_card as Record<string, unknown>) }
      : {};
  rawCard.debate_run_id = runId;
  delete rawCard.completion_proof;
  if (payload.completion_proof && typeof payload.completion_proof === "object") rawCard.completion_proof = payload.completion_proof;
  rawCard.analysis_degraded = Boolean(payload.analysis_degraded || rawCard.analysis_degraded);
  rawCard.degraded_agents = Array.isArray(payload.degraded_agents)
    ? payload.degraded_agents
    : rawCard.degraded_agents;
  return rawCard;
}

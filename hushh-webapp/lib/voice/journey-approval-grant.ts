/**
 * The approval a person gave for a journey's enumerated steps.
 *
 * A journey's whole purpose is to cross a screen boundary, so the approval
 * that covers it has to survive that crossing. Held in a component ref it did
 * not: a ref survives re-renders but not a remount, and the agent surface can
 * remount during exactly the navigation the grant exists to span. The grant
 * then vanished with no trace -- nothing called the clear path, so there was
 * not even a log to explain it, and the second step silently asked again.
 *
 * Module scope instead. Explicit invalidation is unchanged and still the only
 * way a grant ends: a new user turn, a transport error, a closed session, or
 * expiry. It simply stops being destroyed by accident.
 *
 * Deliberately narrow: it names the goal AND the exact action ids, so a
 * directive that drifts to another goal, or to a step outside the approved
 * list, still gets its own confirmation.
 */

export type JourneyApprovalGrant = {
  goalId: string;
  actionIds: string[];
  expiresAt: number;
};

/** How long one journey approval stays good for. */
export const JOURNEY_GRANT_TTL_MS = 120_000;

let activeGrant: JourneyApprovalGrant | null = null;

export function recordJourneyApproval(goalId: string, actionIds: string[]): void {
  const cleanGoalId = String(goalId || "").trim();
  const cleanActionIds = actionIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (!cleanGoalId || cleanActionIds.length === 0) return;
  activeGrant = {
    goalId: cleanGoalId,
    actionIds: cleanActionIds,
    expiresAt: Date.now() + JOURNEY_GRANT_TTL_MS,
  };
  console.info(
    `[AgentBar] Journey approved: ${cleanGoalId} covers ${cleanActionIds.join(", ")}`,
  );
}

/**
 * Whether an approval already covers this directive.
 *
 * Logs the decision either way. The previous version could only report an
 * explicit clear, so "never recorded" and "recorded, nobody tapped" looked
 * identical from outside -- which is precisely the question that mattered.
 */
export function isCoveredByJourneyApproval(
  goalId: string | null,
  actionId: string,
): boolean {
  if (!goalId) return false;
  const grant = activeGrant;
  if (!grant) {
    console.info(`[AgentBar] Journey coverage: none held, ${actionId} will ask`);
    return false;
  }
  if (Date.now() >= grant.expiresAt) {
    clearJourneyApproval("expired");
    return false;
  }
  const covered = grant.goalId === goalId && grant.actionIds.includes(actionId);
  console.info(
    `[AgentBar] Journey coverage: ${actionId} ${covered ? "covered" : "NOT covered"} ` +
      `by ${grant.goalId} [${grant.actionIds.join(", ")}]`,
  );
  return covered;
}

export function clearJourneyApproval(reason: string): void {
  if (!activeGrant) return;
  console.info(`[AgentBar] Journey approval cleared: ${reason}`);
  activeGrant = null;
}

/** Test seam: no production caller should need to read the grant directly. */
export function readJourneyApprovalForTest(): JourneyApprovalGrant | null {
  return activeGrant;
}

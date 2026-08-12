import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import type { SpecialistDirective, DelegateResult } from "@/lib/agent/specialist-directive-runtime";

/** Execute the exact, server-persisted Calendar proposal shown in the chat card. */
export async function runCalendarDirective(
  directive: SpecialistDirective,
  vaultOwnerToken: string,
  userId: string,
): Promise<DelegateResult> {
  const payload = directive.payload as Record<string, unknown>;
  const proposalId = String(payload.proposalId ?? "");
  if (payload.type !== "calendar.execute_proposal" || !proposalId) {
    throw new Error("Calendar confirmation is invalid.");
  }
  const result = await GoogleCalendarService.executeProposal({
    vaultOwnerToken,
    userId,
    proposalId,
  });
  return {
    delegate_agent_id: "agent_calendar",
    kind: "action",
    id: proposalId,
    type: `calendar.${result.action}`,
    status: "completed",
    detail:
      result.action === "cancel"
        ? "The event was cancelled."
        : `${result.action === "create" ? "Scheduled" : "Rescheduled"} ${result.event.title || "the event"}.`,
  };
}

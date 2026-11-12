import { calendarProposalReviewError } from "@/lib/agent/calendar-proposal-review";
import { notifyCalendarChanged } from "@/lib/calendar/calendar-refresh";
import type { CalendarExecution } from "@/lib/calendar/calendar-board-booking";
import type {
  DelegateResult,
  SpecialistDirective,
} from "@/lib/agent/specialist-directive-runtime";
import { GoogleCalendarService } from "@/lib/services/google-calendar-service";
import { readPrivateCalendarReplyStatus } from "@/lib/services/private-google-connections";
import {
  calendarTodoInput,
  createTodo,
} from "@/lib/services/todo-list-pkm-service";

function gmailReplyDetail(status?: string): string {
  if (status === "sent") return " The threaded Gmail reply was sent.";
  if (status === "not_sent") return " The Gmail reply was not sent.";
  return " Gmail delivery could not be confirmed. Check the thread before sending another reply.";
}

/**
 * Execute the exact, server-persisted Calendar proposal shown in the chat card.
 *
 * Calendar remains the event source of truth. Once it confirms a new booking,
 * this client-side seam mirrors its safe presentation fields into the owner's
 * encrypted To-do domain. The private key is never sent to Calendar or the
 * backend, and a To-do write failure cannot make an already-booked event fail.
 */
export async function runCalendarDirective(
  directive: SpecialistDirective,
  vaultOwnerToken: string,
  userId: string,
  vaultKey?: string | null,
): Promise<DelegateResult> {
  const payload = directive.payload as Record<string, unknown>;
  const proposalId = String(payload.proposalId ?? "");
  const reviewError = calendarProposalReviewError(payload);
  if (reviewError) throw new Error(reviewError);

  const linkedReply = payload.gmailReply != null;
  const result = await GoogleCalendarService.executeProposal({ vaultOwnerToken, userId, proposalId, accountId: String(payload.accountId) })
    .catch(async (error: unknown): Promise<CalendarExecution> => {
      if (!linkedReply) throw error;
      const receipt = await readPrivateCalendarReplyStatus(proposalId).catch(() => null);
      if (receipt?.calendar === "created") {
        return { action: "create" as const, event: {}, gmail_reply: { status: receipt.gmail } };
      }
      if (receipt?.calendar === "prepared" || receipt?.calendar === "expired") throw error;
      throw new Error(`The Calendar outcome could not be confirmed. Check Calendar before scheduling again.${gmailReplyDetail(receipt?.gmail)}`);
    });

  notifyCalendarChanged(userId);

  let addedToTodoList = false;
  if (result.action === "create" && vaultKey) {
    const todo = calendarTodoInput(result.event);
    if (todo) {
      try {
        const saved = await createTodo(todo, {
          userId,
          vaultKey,
          vaultOwnerToken,
        });
        addedToTodoList = saved.result.success;
      } catch {
        // The booking already succeeded. The Calendar projection still shows it
        // on the list after refresh, so never report the booking as failed.
      }
    }
  }

  const eventTitle = result.event.title || "the event";
  const replyDetail = linkedReply ? gmailReplyDetail(result.gmail_reply?.status) : "";
  const bookingDetail =
    result.action === "cancel"
      ? "The event was cancelled."
      : result.action === "create"
        ? result.event.conference_status === "failure"
          ? `Scheduled ${eventTitle}, but Google Meet could not be added. Check Calendar permissions before trying again.`
          : result.event.conference_url
            ? `Scheduled ${eventTitle} with a Google Meet link. It is ready in the Calendar invite.`
            : `Scheduled ${eventTitle}. Google Meet is being added to the Calendar invite.`
        : `Rescheduled ${eventTitle}.`;

  return {
    delegate_agent_id: "agent_calendar",
    kind: "action",
    id: proposalId,
    type: `calendar.${result.action}`,
    status: "completed",
    detail:
      result.action === "create" && addedToTodoList
        ? `${bookingDetail}${replyDetail} It is also in your To-do list.`
        : `${bookingDetail}${replyDetail}`,
  };
}

import type { CalendarInvitationHandoff, CalendarAttendanceHandoff } from "@/lib/calendar/calendar-invitation-handoff";
import type { CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { trackEvent } from "@/lib/observability/client";

export const openCalendarChat = (prompt?: string, calendarSlot?: CalendarSlotHandoff, calendarInvitation?: CalendarInvitationHandoff, calendarAttendance?: CalendarAttendanceHandoff) => {
  trackEvent("one_calendar_action", { route_id: "one_calendar", action: "chat_opened", result: "success" });
  if (!prompt && !calendarSlot && !calendarInvitation && !calendarAttendance) {
    navigateToAgentChat();
    return;
  }
  const createdAtMs = Date.now();
  useOneConversationSession.getState().createHandoff({
    id: `calendar-prompt-${createdAtMs}`,
    reason: "user_requested",
    transcript: prompt,
    calendarSlot,
    calendarInvitation,
    calendarAttendance,
    createdAtMs,
  });
  navigateToAgentChat();
};

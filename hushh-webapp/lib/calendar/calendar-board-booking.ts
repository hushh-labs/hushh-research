import { ownerContentIsPrivate } from "@/lib/services/private-agent-specialist-chat";
import { PrivateGoogleUnsupportedError } from "@/lib/services/private-google-connections";
import { scheduleRequest } from "@/lib/services/google-calendar-transport";

export type CalendarExecution = {
  action: "create" | "reschedule" | "cancel";
  event: {
    id?: string | null;
    title?: string | null;
    start?: { dateTime?: string; date?: string } | null;
    end?: { dateTime?: string; date?: string } | null;
    status?: string | null;
    conference_url?: string | null;
    conference_status?: string | null;
  };
};

export type CalendarBoardBookingInput = {
  vaultOwnerToken: string;
  userId: string;
  accountId: string;
  checkedAccountIds: string[];
  selectedDate: string;
  title: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees: string[];
  description: string;
  meetingType: "google_meet" | "external_link" | "in_person";
  meetingLink: string;
  location: string;
};

export type CalendarBoardBookingReview = {
  proposal_id: string;
  expires_at: string;
  confirmation_required: true;
  plan: {
    account_id: string;
    title: string;
    start_at: string;
    end_at: string;
    time_zone: string;
    attendees: string[];
    description: string;
    location: string;
    meeting_type: CalendarBoardBookingInput["meetingType"];
    meeting_link: string;
    board_accounts: { account_id: string; account_email: string; binding: string[]; calendar_ids: string[] }[];
    board_conflicts: { account_id: string; account_email: string; start_at: string; end_at: string }[];
  };
};

export async function reviewBoardBooking(params: CalendarBoardBookingInput): Promise<CalendarBoardBookingReview> {
    if (await ownerContentIsPrivate()) throw new PrivateGoogleUnsupportedError("Board booking");
    return scheduleRequest<CalendarBoardBookingReview>("proposals", params.vaultOwnerToken, {
      user_id: params.userId,
      action: "create",
      account_id: params.accountId,
      booking_source: "board",
      checked_account_ids: params.checkedAccountIds,
      selected_date: params.selectedDate,
      title: params.title,
      start_at: params.startAt,
      end_at: params.endAt,
      time_zone: params.timeZone,
      attendees: params.attendees,
      description: params.description,
      meeting_type: params.meetingType,
      meeting_link: params.meetingLink,
      location: params.location,
      send_updates: params.attendees.length > 0,
    });
}

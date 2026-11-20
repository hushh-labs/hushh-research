import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FollowupRequestError } from "@/lib/services/calendar-followups-service";
import { CalendarBookingDialog } from "@/components/calendar/calendar-booking-dialog";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const calls = vi.hoisted(() => ({ review: vi.fn(), execute: vi.fn(), legacyReview: vi.fn(), legacyExecute: vi.fn() }));
vi.mock("@/lib/services/calendar-followups-service", async original => ({
  ...await original<object>(), CalendarFollowupsService: { reviewBooking: calls.review, executeBooking: calls.execute },
}));
vi.mock("@/lib/services/google-calendar-service", async original => ({
  ...await original<object>(), GoogleCalendarService: { reviewBoardBooking: calls.legacyReview, executeProposal: calls.legacyExecute },
}));
const request = { id: "11111111-1111-4111-8111-111111111111", revision: 2 };
function show() {
  return render(<CalendarBookingDialog opening={{ start_at: "2099-11-18T10:00:00Z", end_at: "2099-11-18T10:30:00Z", accountId: "account-b", scope: "account", titleHint: "Project review", followupRequest: request }}
    accounts={[{ account_id: "account-b", google_email: "owner@example.test", connected: true, status: "connected", access_level: "manage", calendar_list_access: true }]}
    people={new Map()} accountPeople={new Map()} userId="owner" token={null} getIdToken={async () => "firebase"}
    timeZone="UTC" alternatives={[]} onClose={vi.fn()} onConfirmed={vi.fn()} onConflict={vi.fn()} onRequireWrite={vi.fn()} />);
}
beforeEach(() => {
  Object.values(calls).forEach(call => call.mockReset());
  publishValidatedAuthSessionOwner("owner");
  calls.review.mockImplementation(async input => ({ proposal_id: "proposal-b", review_token: "sealed", expires_at: "2099-12-01T00:00:00Z", plan: { account_id: input.accountId, start_at: input.startAt, end_at: input.endAt, board_conflicts: [] } }));
  calls.execute.mockResolvedValue({ action: "create", event: { id: "created" } });
});
it("schedules a reviewed follow-up with no vault and retains the dispatch fence", async () => {
  show();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(calls.execute).toHaveBeenCalledOnce());
  expect(calls.execute).toHaveBeenCalledWith("owner", "account-b", request, "proposal-b", "sealed", "firebase", expect.any(Function));
  expect(calls.legacyReview).not.toHaveBeenCalled();
  expect(calls.legacyExecute).not.toHaveBeenCalled();
  expect(screen.queryByText(/Unlock One/)).toBeNull();
});
it("never falls back to broad proposal execution when the review token is missing", async () => {
  const original = calls.review.getMockImplementation()!;
  calls.review.mockImplementation(async input => ({ ...await original(input), review_token: undefined }));
  show();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" }));
  await screen.findByText("Calendar review was incomplete. Review the meeting again.");
  expect(calls.execute).not.toHaveBeenCalled();
  expect(calls.legacyExecute).not.toHaveBeenCalled();
});

it("allows retry after a known pre-write Calendar conflict", async () => {
  calls.execute.mockRejectedValueOnce(new FollowupRequestError("calendar_availability_changed", 409));
  show();
  const submit = within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" });
  fireEvent.click(submit);
  await screen.findByText("Calendar or follow-up details changed. Review the meeting and try again.");
  expect(screen.queryByText(/event may have been created/)).toBeNull();
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() => expect(calls.execute).toHaveBeenCalledTimes(2));
});

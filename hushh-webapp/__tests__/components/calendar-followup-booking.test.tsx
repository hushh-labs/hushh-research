import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { FollowupRequestError } from "@/lib/services/calendar-followups-service";
import { CalendarBookingDialog } from "@/components/calendar/calendar-booking-dialog";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { advanceVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { GoogleCalendarError } from "@/lib/services/google-calendar-transport";

const calls = vi.hoisted(() => ({ review: vi.fn(), execute: vi.fn(), legacyReview: vi.fn(), legacyExecute: vi.fn(), track: vi.fn() }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: calls.track }));
vi.mock("@/lib/services/calendar-followups-service", async original => ({
  ...await original<object>(), CalendarFollowupsService: { reviewBooking: calls.review, executeBooking: calls.execute },
}));
vi.mock("@/lib/services/google-calendar-service", async original => ({
  ...await original<object>(), GoogleCalendarService: { reviewBoardBooking: calls.legacyReview, executeProposal: calls.legacyExecute },
}));
const request = { id: "11111111-1111-4111-8111-111111111111", revision: 2 };
function show(followup = true) {
  return render(<CalendarBookingDialog opening={{ start_at: "2099-11-18T10:00:00Z", end_at: "2099-11-18T10:30:00Z", accountId: "account-b", scope: "account", titleHint: "Project review", ...(followup ? { followupRequest: request } : {}) }}
    accounts={[{ account_id: "account-b", google_email: "owner@example.test", connected: true, status: "connected", access_level: "manage", calendar_list_access: true }]}
    people={new Map()} accountPeople={new Map()} userId="owner" token={followup ? null : "vault"} getIdToken={async () => "firebase"}
    timeZone="UTC" alternatives={[]} onClose={vi.fn()} onConfirmed={vi.fn()} onConflict={vi.fn()} onRequireWrite={vi.fn()} />);
}
beforeEach(() => {
  Object.values(calls).forEach(call => call.mockReset());
  publishValidatedAuthSessionOwner("owner");
  calls.review.mockImplementation(async input => ({ proposal_id: "proposal-b", review_token: "sealed", expires_at: "2099-12-01T00:00:00Z", plan: { account_id: input.accountId, start_at: input.startAt, end_at: input.endAt, board_conflicts: [] } }));
  calls.execute.mockResolvedValue({ action: "create", event: { id: "created" } });
  calls.legacyReview.mockImplementation(calls.review.getMockImplementation()!);
  calls.legacyExecute.mockResolvedValue({ action: "create", event: { id: "created" } });
});
it("schedules a reviewed follow-up with no vault and retains the dispatch fence", async () => {
  show();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(calls.execute).toHaveBeenCalledOnce());
  expect(calls.execute).toHaveBeenCalledWith("owner", "account-b", request, "proposal-b", "sealed", "firebase", expect.any(Function));
  expect(calls.legacyReview).not.toHaveBeenCalled();
  expect(calls.legacyExecute).not.toHaveBeenCalled();
  expect(screen.queryByText(/Unlock One/)).toBeNull();
  expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "success" });
});
it("never falls back to broad proposal execution when the review token is missing", async () => {
  const original = calls.review.getMockImplementation()!;
  calls.review.mockImplementation(async input => ({ ...await original(input), review_token: undefined }));
  show();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" }));
  await screen.findByText("Calendar review was incomplete. Review the meeting again.");
  expect(calls.execute).not.toHaveBeenCalled();
  expect(calls.legacyExecute).not.toHaveBeenCalled();
  expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "error" });
});

it("allows retry after a known pre-write Calendar conflict", async () => {
  calls.execute.mockRejectedValueOnce(new FollowupRequestError("calendar_availability_changed", 409));
  show();
  const submit = within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" });
  fireEvent.click(submit);
  await screen.findByText("Calendar or follow-up details changed. Review the meeting and try again.");
  expect(screen.queryByText(/event may have been created/)).toBeNull();
  expect(submit).toBeEnabled();
  expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "expected_error" });
  fireEvent.click(submit);
  await waitFor(() => expect(calls.execute).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(calls.track).toHaveBeenNthCalledWith(2, "one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "success" }));
});

const schedule = () => fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" }));

it("records one provider-confirmed direct booking without private event data", async () => {
  show(false);
  const submit = within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" });
  fireEvent.click(submit); fireEvent.click(submit);
  await waitFor(() => expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "success" }));
  expect(calls.legacyExecute).toHaveBeenCalledOnce();
});

it("records a failed review before any provider write", async () => {
  calls.legacyReview.mockRejectedValue(new Error("Private review diagnostic"));
  show(false); schedule();
  await waitFor(() => expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "error" }));
  expect(calls.legacyExecute).not.toHaveBeenCalled();
});

it.each(["conflict", "changed_plan"])("records the authoritative prewrite %s block separately", async (kind) => {
  const original = calls.legacyReview.getMockImplementation()!;
  calls.legacyReview.mockImplementation(async input => {
    const proposal = await original(input);
    if (kind === "conflict") proposal.plan.board_conflicts = [{ account_id: "private", account_email: "private@example.test", start_at: input.startAt }];
    else proposal.plan.account_id = "changed";
    return proposal;
  });
  show(false); schedule();
  await waitFor(() => expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "expected_error" }));
  expect(calls.legacyExecute).not.toHaveBeenCalled();
});

it("records an authoritative provider prewrite rejection, not a failed created event", async () => {
  calls.legacyExecute.mockRejectedValue(new GoogleCalendarError("Private detail", "calendar_permission_required", 409));
  show(false); schedule();
  await waitFor(() => expect(calls.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "expected_error" }));
});

it.each(["timeout", "invalid_response", "wrong_action"])("does not count an uncertain post-write %s as failed or confirmed", async (kind) => {
  if (kind === "timeout") calls.legacyExecute.mockRejectedValue(new TypeError("Private provider error"));
  else calls.legacyExecute.mockResolvedValue({ action: kind === "wrong_action" ? "reschedule" : "create", event: kind === "wrong_action" ? { id: "private" } : {} });
  show(false); schedule();
  await screen.findByText(/The event may have been created/);
  expect(calls.track).not.toHaveBeenCalled();
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" })).toBeDisabled();
});

it.each(["missing_owner", "owner_change", "vault_change"])("omits attribution for %s", async (kind) => {
  if (kind === "missing_owner") publishValidatedAuthSessionOwner(null);
  let finish!: (result: { action: string; event: { id: string } }) => void;
  calls.legacyExecute.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  show(false); schedule();
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  if (kind === "owner_change") publishValidatedAuthSessionOwner("next-owner");
  if (kind === "vault_change") advanceVaultSessionEpoch();
  await act(async () => finish({ action: "create", event: { id: "private-event" } }));
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Schedule meeting" })).not.toHaveTextContent("Scheduling"));
  expect(calls.track).not.toHaveBeenCalled();
});

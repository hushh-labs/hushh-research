import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarBoardBookingReview, GoogleCalendarAccount } from "@/lib/services/google-calendar-service";

const state = vi.hoisted(() => ({ review: vi.fn(), execute: vi.fn(), track: vi.fn(), confirmed: vi.fn(), closed: vi.fn(), epoch: 1 }));
vi.mock("@/lib/services/google-calendar-service", () => ({ GoogleCalendarService: { reviewBoardBooking: state.review, executeProposal: state.execute } }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: state.track }));
vi.mock("@/lib/navigation/back-layers", () => ({ useBackLayer: vi.fn() }));
vi.mock("@/components/calendar/calendar-person-avatar", () => ({ CalendarPersonAvatar: () => null }));
vi.mock("@/lib/vault/session-epoch", () => ({ snapshotVaultSessionEpoch: () => state.epoch, isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch }));

import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { CalendarBookingDialog, type BookingOpening } from "@/components/calendar/calendar-booking-dialog";
import { GoogleCalendarError } from "@/lib/services/google-calendar-transport";

const account = { account_id: "PRIVATE_ACCOUNT_ID", google_email: "PRIVATE_EMAIL@example.test", connected: true, status: "connected", access_level: "manage", calendar_list_access: true } satisfies GoogleCalendarAccount;
const opening = { start_at: "2026-11-28T12:00:00Z", end_at: "2026-11-28T12:30:00Z", accountId: account.account_id, scope: "account", titleHint: "PRIVATE_MEETING_TITLE" } satisfies BookingOpening;
const review = (): CalendarBoardBookingReview => ({
  proposal_id: "PRIVATE_PROPOSAL_ID", expires_at: "2026-11-27T12:10:00Z", confirmation_required: true,
  plan: { account_id: account.account_id, title: opening.titleHint, start_at: opening.start_at, end_at: opening.end_at, time_zone: "UTC", attendees: [], description: "PRIVATE_DESCRIPTION", location: "", meeting_type: "google_meet", meeting_link: "", board_accounts: [{ account_id: account.account_id, account_email: account.google_email, binding: [], calendar_ids: [] }], board_conflicts: [] },
});
const result = { action: "create", event: { id: "PRIVATE_EVENT_ID" } };
function mount() {
  return render(<CalendarBookingDialog opening={opening} accounts={[account]} people={new Map()} accountPeople={new Map()} userId="owner-a" token="synthetic-token" timeZone="UTC" alternatives={[]} onClose={state.closed} onConfirmed={state.confirmed} onConflict={vi.fn()} onRequireWrite={vi.fn()} />);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
  state.epoch = 1;
  publishValidatedAuthSessionOwner("owner-a");
  state.review.mockImplementation(async () => review());
  state.execute.mockResolvedValue(result);
});
afterEach(() => { publishValidatedAuthSessionOwner(null); vi.useRealTimers(); });

it("does not count opening or cancellation as a booking", () => {
  mount();
  expect(state.track).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(state.closed).toHaveBeenCalledOnce();
  expect(state.execute).not.toHaveBeenCalled();
  expect(state.track).not.toHaveBeenCalled();
});

it("records one provider-confirmed create and excludes private fields", async () => {
  mount();
  const button = screen.getByRole("button", { name: "Schedule meeting" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(state.confirmed).toHaveBeenCalledOnce());
  expect(state.execute).toHaveBeenCalledOnce();
  expect(state.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "success" });
  expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
});

it("records a board conflict as an expected prewrite block", async () => {
  state.review.mockResolvedValue({ ...review(), plan: { ...review().plan, board_conflicts: [{ account_id: account.account_id, account_email: account.google_email, start_at: opening.start_at, end_at: opening.end_at }] } });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "expected_error" }));
  expect(state.execute).not.toHaveBeenCalled();
});

it("records an expired review as an expected prewrite block", async () => {
  state.review.mockResolvedValue({ ...review(), expires_at: "2026-11-27T11:59:00Z" });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "expected_error" }));
  expect(state.execute).not.toHaveBeenCalled();
});

it("records only the definite review-stage failure as error", async () => {
  state.review.mockRejectedValue(new Error("PRIVATE_PROVIDER_DIAGNOSTIC"));
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "error" }));
  expect(state.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
});

it.each(["review", "execute"] as const)("retains an authoritative %s-stage prewrite block as expected_error", async stage => {
  const failure = new GoogleCalendarError("PRIVATE_PROVIDER_DIAGNOSTIC", stage === "review" ? "calendar_destination_read_only" : "calendar_availability_changed", stage === "review" ? 403 : 409);
  if (stage === "review") {
    state.review.mockRejectedValue(failure);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  } else {
    state.execute.mockRejectedValue(failure);
    mount(); fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  }
  await waitFor(() => expect(state.track).toHaveBeenCalledExactlyOnceWith("one_calendar_action", { route_id: "one_calendar", action: "booking_create", result: "expected_error" }));
  expect(JSON.stringify(state.track.mock.calls)).not.toContain("PRIVATE");
});

it.each(["timeout", "missing-id", "wrong-action"] as const)("leaves %s after execution unconfirmed", async mode => {
  if (mode === "timeout") state.execute.mockRejectedValue(new Error("PRIVATE_PROVIDER_TIMEOUT"));
  else state.execute.mockResolvedValue(mode === "missing-id" ? { action: "create", event: {} } : { action: "cancel", event: { id: "PRIVATE_EVENT_ID" } });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
  await act(async () => {});
  expect(state.track).not.toHaveBeenCalled();
});

it.each(["missing-owner", "changed-owner", "vault-epoch", "unmounted"] as const)("drops the booking observation for %s", async guard => {
  if (guard === "missing-owner") publishValidatedAuthSessionOwner(null);
  let finish!: (value: unknown) => void;
  state.execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = mount();
  fireEvent.click(screen.getByRole("button", { name: "Schedule meeting" }));
  await waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
  if (guard === "changed-owner") publishValidatedAuthSessionOwner("owner-b");
  if (guard === "vault-epoch") state.epoch++;
  if (guard === "unmounted") view.unmount();
  await act(async () => { finish(result); });
  expect(state.track).not.toHaveBeenCalled();
});

import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicOptions: vi.fn(),
  privateAuth: vi.fn(() => { throw new Error("Public link attempted owner login"); }),
  privateVault: vi.fn(() => { throw new Error("Public link attempted owner vault access"); }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: mocks.privateAuth }));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: mocks.privateVault }));
vi.mock("@/lib/services/google-calendar-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/services/google-calendar-service")>(),
  GoogleCalendarService: { publicReschedulingOptions: mocks.publicOptions },
}));

import { CalendarReschedulingPage } from "@/components/calendar/calendar-rescheduling-page";
import { GoogleCalendarError } from "@/lib/services/google-calendar-service";

const offered = {
  openings: [{ start_at: "2026-10-15T10:00:00Z", end_at: "2026-10-15T10:30:00Z" }],
  time_zone: "Asia/Kolkata", reply_to: "owner@example.com",
  event_link: "https://calendar.google.com/calendar/event?eid=specific-invitation",
};

describe("recipient-accessible Calendar rescheduling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.publicOptions.mockReset();
    window.history.replaceState({}, "", "/calendar/reschedule#reviewed-recipient-capability");
    delete window.__oneCalendarReschedulingCapability;
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
    delete window.__oneCalendarReschedulingCapability;
  });

  it("scrubs the capability before fetching and gives the recipient real suggestions without login", async () => {
    mocks.publicOptions.mockImplementation(async (capability: string) => {
      expect(window.location.hash).toBe("");
      expect(capability).toBe("reviewed-recipient-capability");
      return offered;
    });
    render(<StrictMode><CalendarReschedulingPage /></StrictMode>);

    const suggestion = await screen.findByRole("link", { name: /^Suggest / });
    const href = decodeURIComponent(suggestion.getAttribute("href")!);
    expect(href).toContain("mailto:owner@example.com?");
    expect(href).toContain("UTC+05:30");
    expect(href).not.toContain("Asia/Kolkata");
    expect(href).toContain("30 minutes");
    expect(screen.getByRole("link", { name: "Open this meeting in Google Calendar", exact: true })).toHaveAttribute("href", offered.event_link);
    expect(window.location.hash).toBe("");
    expect(mocks.publicOptions).toHaveBeenCalledOnce();
    expect(mocks.privateAuth).not.toHaveBeenCalled();
    expect(mocks.privateVault).not.toHaveBeenCalled();
  });

  it("consumes the shell-captured capability once after the shell already removed the fragment", async () => {
    window.history.replaceState({}, "", "/calendar/reschedule");
    window.__oneCalendarReschedulingCapability = "captured-recipient-capability";
    mocks.publicOptions.mockResolvedValueOnce(offered);
    render(<CalendarReschedulingPage />);

    await screen.findByRole("link", { name: /^Suggest / });
    expect(mocks.publicOptions).toHaveBeenCalledWith("captured-recipient-capability");
    expect(window.__oneCalendarReschedulingCapability).toBeUndefined();
  });

  it("shows each offered time's own offset across a clock change", async () => {
    mocks.publicOptions.mockResolvedValueOnce({
      ...offered,
      time_zone: "America/New_York",
      openings: [
        { start_at: "2027-03-14T06:30:00Z", end_at: "2027-03-14T07:00:00Z" },
        { start_at: "2027-03-14T07:30:00Z", end_at: "2027-03-14T08:00:00Z" },
      ],
    });
    render(<CalendarReschedulingPage />);
    const suggestions = await screen.findAllByRole("link", { name: /^Suggest / });
    expect(suggestions[0]).toHaveTextContent("UTC-05:00");
    expect(suggestions[1]).toHaveTextContent("UTC-04:00");
  });

  it.each([
    new GoogleCalendarError("This Calendar link expired. Ask for a new one.", "calendar_review_expired", 410),
    new GoogleCalendarError("A checked calendar is unavailable.", "calendar_invalid_response", 502),
  ])("does not describe expired or unavailable capability data as free time", async failure => {
    mocks.publicOptions.mockRejectedValueOnce(failure);
    render(<CalendarReschedulingPage />);

    expect(await screen.findByText("Availability could not be checked.")).toBeInTheDocument();
    expect(screen.getByText(failure.message)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Suggest / })).toBeNull();
    expect(screen.queryByText("The offered times are no longer available. Reply to the sender to request new options.")).toBeNull();
  });

  it("does not fetch anything when a recipient link is incomplete", async () => {
    window.history.replaceState({}, "", "/calendar/reschedule");
    render(<CalendarReschedulingPage />);

    await screen.findByText("This rescheduling link is incomplete. Ask the sender for a new link.");
    expect(mocks.publicOptions).not.toHaveBeenCalled();
    expect(mocks.privateAuth).not.toHaveBeenCalled();
    expect(mocks.privateVault).not.toHaveBeenCalled();
  });

  it("honestly explains when live checks remove all previously offered times", async () => {
    mocks.publicOptions.mockResolvedValueOnce({ ...offered, openings: [] });
    render(<CalendarReschedulingPage />);

    await waitFor(() => expect(screen.getByText("The offered times are no longer available. Reply to the sender to request new options.")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /^Suggest / })).toBeNull();
    expect(screen.queryByText("Availability could not be checked.")).toBeNull();
  });
});

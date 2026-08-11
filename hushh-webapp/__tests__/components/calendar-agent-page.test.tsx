import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  startConnect: vi.fn(),
  disconnect: vi.fn(),
  getIdToken: vi.fn(),
  openAgent: vi.fn(),
}));

vi.mock("@/components/agent/agent-popover-provider", () => ({
  useOptionalAgentPopover: () => ({ openAgent: mocks.openAgent }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { uid: "calendar-user", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    status: mocks.status,
    startConnect: mocks.startConnect,
    disconnect: mocks.disconnect,
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";

describe("CalendarAgentPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIdToken.mockResolvedValue("firebase-token");
  });

  it("requests management access in the single initial Calendar authorization", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });
    mocks.startConnect.mockRejectedValue(new Error("stop after request"));

    render(<CalendarAgentPage />);

    const connect = await screen.findByRole("button", {
      name: "Connect Calendar",
    });
    fireEvent.click(connect);

    await waitFor(() =>
      expect(mocks.startConnect).toHaveBeenCalledWith({
        idToken: "firebase-token",
        userId: "calendar-user",
        accessLevel: "manage",
      }),
    );
    expect(screen.queryByRole("button", { name: "Connect with scheduling" })).toBeNull();
  });

  it("keeps a healthy Calendar connection focused on chat and disconnect", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "manage",
      scope_csv: "calendar.events calendar.freebusy",
    });

    render(<CalendarAgentPage />);

    await screen.findByText("Connected");
    const chat = screen.getByRole("button", {
      name: "Try Calendar Agent with One",
    });
    expect(chat).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Calendar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable scheduling" })).toBeNull();

    fireEvent.click(chat);
    expect(mocks.openAgent).toHaveBeenCalledWith({
      handoff: expect.objectContaining({
        reason: "user_requested",
        transcript: "Summarize my calendar events",
      }),
    });
  });

  it("does not offer reconnect for a connected read-only Calendar", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: true,
      status: "connected",
      google_email: "owner@example.com",
      access_level: "read",
      scope_csv: "calendar.freebusy",
    });

    render(<CalendarAgentPage />);

    await screen.findByText("View events and availability");
    expect(screen.queryByRole("button", { name: /Reconnect/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try Calendar Agent with One" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Calendar" })).toBeTruthy();
  });

  it("keeps the Calendar connection surface focused on connection", async () => {
    mocks.status.mockResolvedValue({
      configured: true,
      connected: false,
      status: "disconnected",
      scope_csv: "",
    });

    render(<CalendarAgentPage journeyVariant="onboarding" />);

    expect(await screen.findByText("Connect Google Calendar")).toBeTruthy();
    expect(screen.queryByText("Try asking One")).toBeNull();
    expect(screen.queryByText(/Summarize my calendar for this week/)).toBeNull();
  });
});

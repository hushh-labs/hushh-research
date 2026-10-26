import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  startConnect: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  getIdToken: vi.fn(),
  trackEvent: vi.fn(),
  popup: null as Window | null,
  popupAttempt: "",
}));

vi.mock("@/components/calendar/calendar-connected-workspace", () => ({
  CalendarConnectedWorkspace: ({ busy, onAddAccount, connectionNotice }: {
    busy: boolean;
    onAddAccount: () => void;
    connectionNotice?: ReactNode;
  }) => <main>
    <button disabled={busy} onClick={onAddAccount}>Add Calendar account</button>
    {connectionNotice}
  </main>,
}));
vi.mock("@capacitor/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@capacitor/core")>(),
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: "calendar-user",
    user: { uid: "calendar-user", getIdToken: mocks.getIdToken },
    loading: false,
  }),
}));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { status: mocks.status, startConnect: mocks.startConnect },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: mocks.getPersonalAgentStatus },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: "calendar-user" }) },
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: null, vaultOwnerToken: null }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), promise: vi.fn() },
}));

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

describe("Calendar Add account popup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishValidatedAuthSessionPrincipal({
      firebaseUid: "calendar-user", ownerId: "calendar-user", accountGeneration: 0,
    });
    mocks.getPersonalAgentStatus.mockResolvedValue({ hostingMode: "shared" });
    mocks.getIdToken.mockResolvedValue("synthetic-id-token");
    mocks.popupAttempt = "";
    mocks.status.mockResolvedValue({
      configured: true, connected: true, status: "connected",
      access_level: "manage", scope_csv: "",
      accounts: [{ account_id: "default", connected: true, status: "connected", access_level: "manage" }],
    });
    mocks.startConnect.mockResolvedValue({
      authorize_url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(new URL("/one/profile/google/oauth/return", window.location.origin).href)}`,
    });
    vi.spyOn(window, "open").mockImplementation(() => (mocks.popup = ({
      close: vi.fn(),
      document: { title: "" },
      focus: vi.fn(),
      location: { replace: vi.fn() },
      sessionStorage: {
        setItem: vi.fn((_key: string, value: string) => { mocks.popupAttempt = value; }),
        getItem: vi.fn(() => mocks.popupAttempt || null),
      },
    }) as unknown as Window));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function beginAddAccount() {
    render(<CalendarAgentPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Calendar account" }));
    await waitFor(() => expect((mocks.popup as unknown as {
      location: { replace: ReturnType<typeof vi.fn> };
    }).location.replace).toHaveBeenCalled());
    expect(JSON.parse(mocks.popupAttempt)).toMatchObject({ calendarAdditional: true });
  }

  it("does not count expiry as success from the existing primary grant", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await beginAddAccount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    expect(mocks.trackEvent).toHaveBeenCalledWith("one_calendar_action", {
      route_id: "one_calendar", action: "connected", result: "error",
    });
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action", expect.objectContaining({ result: "success" }),
    );
  });

  it("does not count cancellation as success from the existing primary grant", async () => {
    await beginAddAccount();
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));

    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledWith("one_calendar_action", {
      route_id: "one_calendar", action: "connected", result: "expected_error",
    }));
    expect(mocks.trackEvent).not.toHaveBeenCalledWith(
      "one_calendar_action", expect.objectContaining({ result: "success" }),
    );
  });
});

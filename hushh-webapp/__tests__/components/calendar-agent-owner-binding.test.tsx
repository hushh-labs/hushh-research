import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionPrincipal } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  ownerId: "calendar-user",
  status: vi.fn(),
  startConnect: vi.fn(),
  getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  popup: null as Window | null,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: mocks.ownerId,
    user: {
      uid: "calendar-user",
      email: "calendar-user@example.com",
      getIdToken: mocks.getIdToken,
    },
    loading: false,
  }),
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getCurrentUser: () => ({ uid: "calendar-user" }) },
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: null, vaultOwnerToken: null }),
}));
vi.mock("@/lib/services/private-agent-specialist-chat", () => ({
  ownerContentIsPrivate: async () => false,
}));
vi.mock("@/components/connections/google-connector-transition-review", () => ({
  useGoogleConnectorTransitionReview: () => ({
    confirmTransition: vi.fn(), transitionDialog: null,
  }),
}));
vi.mock("@capacitor/core", async importOriginal => {
  const original = await importOriginal<typeof import("@capacitor/core")>();
  return { ...original, Capacitor: { ...original.Capacitor, isNativePlatform: () => false } };
});
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { status: mocks.status, startConnect: mocks.startConnect },
}));
vi.mock("@/components/calendar/calendar-connected-workspace", () => ({
  CalendarConnectedWorkspace: ({ userId, status, onConnect }: {
    userId: string;
    status: { google_email: string };
    onConnect: (level: "manage", includeList: boolean) => void;
  }) => <main data-owner-id={userId}>
    <p>{status.google_email}</p>
    <button onClick={() => onConnect("manage", true)}>Review Calendar scheduling</button>
  </main>,
}));

import { CalendarAgentPage } from "@/components/calendar/calendar-agent-page";

describe("Calendar validated owner binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ownerId = "calendar-user";
    publishValidatedAuthSessionPrincipal({
      firebaseUid: "calendar-user", ownerId: "calendar-user", accountGeneration: 0,
    });
    mocks.status.mockImplementation(async (_token: string, ownerId: string) => ({
      configured: true,
      connected: true,
      status: "connected",
      google_email: ownerId === "calendar-user" ? "old@example.com" : "fresh@example.com",
      access_level: "manage",
      scope_csv: "calendar.events calendar.freebusy",
    }));
    mocks.startConnect.mockRejectedValue(new Error("stop after owner check"));
    vi.spyOn(window, "open").mockImplementation(() =>
      (mocks.popup = ({
        close: vi.fn(),
        document: { title: "" },
        focus: vi.fn(),
        location: { replace: vi.fn() },
        sessionStorage: { setItem: vi.fn(), getItem: vi.fn(() => null) },
      }) as unknown as Window),
    );
  });

  it("uses the new application owner for status, workspace and consent while Firebase UID stays fixed", async () => {
    const freshOwner = `acct_${"a".repeat(32)}`;
    const view = render(<CalendarAgentPage />);
    await screen.findByText("old@example.com");

    mocks.ownerId = freshOwner;
    publishValidatedAuthSessionPrincipal({
      firebaseUid: "calendar-user", ownerId: freshOwner, accountGeneration: 1,
    });
    view.rerender(<CalendarAgentPage />);

    expect(screen.queryByText("old@example.com")).toBeNull();
    await screen.findByText("fresh@example.com");
    expect(mocks.status).toHaveBeenLastCalledWith("firebase-token", freshOwner);
    expect(screen.getByRole("main")).toHaveAttribute("data-owner-id", freshOwner);

    fireEvent.click(screen.getByRole("button", { name: "Review Calendar scheduling" }));
    await waitFor(() => expect(mocks.startConnect).toHaveBeenCalledWith(expect.objectContaining({
      idToken: "firebase-token", userId: freshOwner, accessLevel: "manage",
    })));
    await act(async () => Promise.resolve());
  });
});

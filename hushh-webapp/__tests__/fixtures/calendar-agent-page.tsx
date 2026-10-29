import type { CalendarSlotHandoff } from "@/lib/calendar/calendar-slot-handoff";
import type { CalendarAttendanceHandoff, CalendarInvitationHandoff } from "@/lib/calendar/calendar-invitation-handoff";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  getPersonalAgentStatus: vi.fn(),
  startConnect: vi.fn(),
  startNativeConnect: vi.fn(),
  completeNativeConnect: vi.fn(),
  disconnect: vi.fn(),
  getIdToken: vi.fn(),
  navigateToAgentChat: vi.fn(),
  trackEvent: vi.fn(),
  connectCalendar: vi.fn(),
  privateConnect: vi.fn(),
  ownerId: "calendar-user" as string | null,
  native: false,
  authLoading: false,
  popup: null as Window | null,
  popupAttempt: "",
  vaultOwnerToken: null as string | null,
  attendance: null as CalendarAttendanceHandoff | null,
}));

export { mocks };

// Connection/OAuth owner tests use the workspace composition seam; its real
// event, keyboard and attendance behavior is covered in the connected suite.
vi.mock("@/components/calendar/calendar-connected-workspace", () => ({
  CalendarConnectedWorkspace: ({ status, busy, onChat, onDisconnect, onConnect, onAddAccount, onAllowMeetingFiles }: { status: { connected: boolean; google_email?: string; accounts?: { account_id: string }[] }; busy: boolean; onChat: (prompt?: string, slot?: CalendarSlotHandoff, invitation?: CalendarInvitationHandoff, attendance?: CalendarAttendanceHandoff) => void; onDisconnect: () => void; onAddAccount?: () => void; onAllowMeetingFiles?: (accountId: string, context: { accountId: string; day: string; timeZone: string; filter: "all"; query: string }) => void; onConnect: (access: "read" | "manage", includeList: boolean) => void }) => <main><h1>Calendar</h1><p>{status.google_email}</p>{status.connected && <p>Connected</p>}<p>{mocks.vaultOwnerToken ? "Calendar reads authorized" : "Calendar session unavailable"}</p><button disabled={busy} onClick={() => onChat()}>Try Calendar Agent with One</button><button disabled={busy} onClick={() => onChat("Find free time on 2026-10-15 from 10:00 to 16:00 in Asia/Kolkata for 30 minutes.")}>Ask with current window</button><button onClick={() => onChat(undefined, { ownerId: "calendar-user", accountEmail: "calendar-user@example.com", date: "2030-10-15", windowStart: "2030-10-15T10:00:00Z", windowEnd: "2030-10-15T12:00:00Z", durationMinutes: 60, timeZone: "Europe/London" })}>Select free window</button><button onClick={() => { if (mocks.attendance) onChat(undefined, undefined, undefined, mocks.attendance); }}>Finish invitation in One</button>{onAddAccount && <button disabled={busy} onClick={onAddAccount}>Add Calendar account</button>}{status.accounts?.map(account => <button key={account.account_id} disabled={busy} onClick={() => onAllowMeetingFiles?.(account.account_id, { accountId: account.account_id, day: "2026-10-29", timeZone: "Asia/Kolkata", filter: "all", query: "" })}>Allow meeting files {account.account_id}</button>)}<button disabled={busy} onClick={onDisconnect}>Disconnect Calendar</button><button disabled={busy} onClick={() => onConnect("manage", true)}>Review Calendar scheduling</button></main>,
}));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: { ...actual.Capacitor, isNativePlatform: () => mocks.native },
  };
});
vi.mock("@/lib/capacitor", () => ({
  HushhAuth: { connectCalendar: mocks.connectCalendar },
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: mocks.trackEvent }));

vi.mock("@/lib/navigation/agent-navigation", () => ({
  navigateToAgentChat: mocks.navigateToAgentChat,
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    userId: mocks.ownerId,
    user: mocks.ownerId
      ? { uid: mocks.ownerId, email: `${mocks.ownerId}@example.com`, displayName: "Calendar owner", getIdToken: mocks.getIdToken }
      : null,
    loading: mocks.authLoading,
  }),
}));

vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: {
    status: mocks.status,
    startConnect: mocks.startConnect,
    startNativeConnect: mocks.startNativeConnect,
    completeNativeConnect: mocks.completeNativeConnect,
    disconnect: mocks.disconnect,
  },
}));

// These Calendar cases exercise the explicitly selected Shared runtime.
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPersonalAgentStatus: mocks.getPersonalAgentStatus },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: {
    getCurrentUser: () => mocks.ownerId ? { uid: mocks.ownerId } : null,
  },
}));
vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({ vaultKey: mocks.vaultOwnerToken ? "synthetic-vault-key" : null, vaultOwnerToken: mocks.vaultOwnerToken }),
}));

vi.mock("@/lib/one/google-native-connect", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/one/google-native-connect")>(),
  connectGoogleConnector: mocks.privateConnect,
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), promise: vi.fn() } }));

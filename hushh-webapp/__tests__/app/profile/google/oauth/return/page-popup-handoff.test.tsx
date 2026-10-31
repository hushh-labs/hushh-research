import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchGet: vi.fn(),
  completeConnect: vi.fn(),
  status: vi.fn(),
  consumeSetupReturn: vi.fn(),
  markMeetingReturn: vi.fn(),
  getIdToken: vi.fn(),
  readAttempt: vi.fn(),
  clearAttempt: vi.fn(),
  settle: vi.fn(),
  trackEvent: vi.fn(),
  ownerId: "synthetic-owner" as string | null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => ({ get: mocks.searchGet }),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mocks.ownerId
      ? { uid: mocks.ownerId, getIdToken: mocks.getIdToken }
      : null,
    userId: mocks.ownerId || null,
    loading: false,
  }),
}));
vi.mock("@/lib/calendar/calendar-oauth-journey", () => ({
  consumeCalendarSetupOAuthReturn: mocks.consumeSetupReturn,
  markCalendarMeetingOAuthReturn: mocks.markMeetingReturn,
}));
vi.mock("@/lib/services/google-connection-service", () => ({
  GoogleConnectionService: { completeConnect: mocks.completeConnect },
}));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { status: mocks.status },
}));
vi.mock("@/lib/google/google-oauth-popup", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/google/google-oauth-popup")>(),
  clearGoogleOAuthAttempt: mocks.clearAttempt,
  readGoogleOAuthPopupAttempt: mocks.readAttempt,
  settleGoogleOAuthPopup: mocks.settle,
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));
import GoogleOAuthReturnPage from "@/app/profile/google/oauth/return/page";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const connected = (service = "calendar") => ({
  connected: true,
  status: "connected",
  service,
});
const attempt = (service = "calendar") => ({
  service,
  attemptId: "synthetic-attempt",
  version: 1,
  startedAt: Date.now(),
  ownerId: "synthetic-owner",
});
const sameWindowAttempt = () => ({ ...attempt(), returnMode: "same_window" as const });
/** Click without letting jsdom attempt a real page navigation. */
function clickLink(link: HTMLElement) {
  link.addEventListener("click", event => event.preventDefault(), { once: true });
  fireEvent.click(link);
}

describe("GoogleOAuthReturnPage when the popup cannot close", () => {
  const meetingReturn = { accountId: "default", day: "2026-10-28", timeZone: "Asia/Kolkata", filter: "recording" as const, query: "" };
  const meetingAttempt = () => ({
    ...attempt(), meetingFiles: true, targetAccountId: "default", expectedSubjectSha256: "a".repeat(64),
    priorGrantGeneration: "old", meetingReturn,
  });
  const grantedAccounts = () => ({
    ...connected(), completed_account_id: "default",
    accounts: [{
      account_id: "default", connected: true, status: "connected", access_level: "read",
      scope_csv: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly https://www.googleapis.com/auth/drive.metadata.readonly",
      provider_subject_sha256: "a".repeat(64), grant_generation: "new",
    }],
  });
  const originalClosed = Object.getOwnPropertyDescriptor(window, "closed");
  let windowClosed = false;
  beforeEach(() => {
    vi.resetAllMocks();
    windowClosed = false;
    Object.defineProperty(window, "closed", { configurable: true, get: () => windowClosed });
    mocks.ownerId = "synthetic-owner";
    publishValidatedAuthSessionOwner("synthetic-owner");
    mocks.getIdToken.mockResolvedValue("synthetic-token");
    mocks.completeConnect.mockResolvedValue(connected());
    mocks.readAttempt.mockReturnValue(null);
    mocks.consumeSetupReturn.mockReturnValue(false);
    mocks.searchGet.mockImplementation((key: string) =>
      key === "code" ? "synthetic-code" : key === "state" ? "synthetic-state" : null);
  });
  afterEach(() => {
    cleanup();
    if (originalClosed) Object.defineProperty(window, "closed", originalClosed);
    else Reflect.deleteProperty(window, "closed");
  });

  it("shows what happened and a working Return to One that restores the exact meeting journey", async () => {
    mocks.readAttempt.mockReturnValue(meetingAttempt());
    mocks.completeConnect.mockResolvedValue(grantedAccounts());
    render(<GoogleOAuthReturnPage />);
    const done = await screen.findByTestId("google-oauth-popup-done", undefined, { timeout: 2000 });
    expect(done.textContent).toContain("Google access saved");
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ attemptId: "synthetic-attempt" }), "succeeded");
    const link = screen.getByRole("link", { name: "Return to One" });
    expect(link.getAttribute("href")).toBe("/one/calendar");
    // The journey context is written only when the person actually returns.
    expect(mocks.markMeetingReturn).not.toHaveBeenCalled();
    clickLink(link);
    expect(mocks.markMeetingReturn).toHaveBeenCalledExactlyOnceWith("synthetic-owner", meetingReturn);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("stays on the loader and shows nothing extra when the popup really closes", async () => {
    mocks.readAttempt.mockReturnValue(meetingAttempt());
    mocks.completeConnect.mockResolvedValue(grantedAccounts());
    windowClosed = true;
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.settle).toHaveBeenCalled());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    expect(screen.queryByTestId("google-oauth-popup-done")).toBeNull();
    expect(screen.getByText("Finishing Google connection…")).toBeTruthy();
  });

  it("says One was updated only after the original page acknowledges this exact attempt", async () => {
    mocks.readAttempt.mockReturnValue(meetingAttempt());
    mocks.completeConnect.mockResolvedValue(grantedAccounts());
    render(<GoogleOAuthReturnPage />);
    const done = await screen.findByTestId("google-oauth-popup-done", undefined, { timeout: 2000 });
    expect(done.textContent).not.toContain("One is updated");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin,
        data: { schemaVersion: 1, type: "google_oauth_settlement_ack", attemptId: "another-attempt-id" } }));
    });
    expect(screen.getByTestId("google-oauth-popup-done").textContent).not.toContain("One is updated");
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin,
        data: { schemaVersion: 1, type: "google_oauth_settlement_ack", attemptId: "synthetic-attempt" } }));
    });
    expect(screen.getByTestId("google-oauth-popup-done").textContent).toContain("One is updated");
    expect(screen.getByRole("link", { name: "Return to One" })).toBeTruthy();
  });

  it("offers Return to One, not a generic connections page, after a failed meeting-access attempt", async () => {
    mocks.readAttempt.mockReturnValue(meetingAttempt());
    mocks.completeConnect.mockResolvedValue({ ...grantedAccounts(), accounts: [{ ...grantedAccounts().accounts[0], scope_csv: "" }] });
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Return to One" });
    expect(link.getAttribute("href")).toBe("/one/calendar");
    expect(screen.queryByRole("link", { name: "Back to connections" })).toBeNull();
    clickLink(link);
    expect(mocks.markMeetingReturn).toHaveBeenCalledExactlyOnceWith("synthetic-owner", meetingReturn);
  });

  it("returns a cancelled meeting consent to the same journey so it can be retried", async () => {
    mocks.readAttempt.mockReturnValue(meetingAttempt());
    mocks.searchGet.mockImplementation((key: string) => key === "error" ? "access_denied" : null);
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/cancelled/)).toBeTruthy();
    expect(mocks.settle).toHaveBeenCalledWith(expect.anything(), "cancelled", expect.any(String));
    expect(screen.getByRole("link", { name: "Return to One" }).getAttribute("href")).toBe("/one/calendar");
  });

  it("returns first-connection setup to Calendar setup", async () => {
    mocks.consumeSetupReturn.mockReturnValue(true);
    mocks.readAttempt.mockReturnValue(attempt());
    render(<GoogleOAuthReturnPage />);
    await screen.findByTestId("google-oauth-popup-done", undefined, { timeout: 2000 });
    expect(screen.getByRole("link", { name: "Return to One" }).getAttribute("href")).toBe("/one/setup/calendar");
  });

  it("keeps connections as the way back for a service with no One journey", async () => {
    mocks.readAttempt.mockReturnValue(attempt("gmail_send"));
    mocks.completeConnect.mockResolvedValue({ ...connected("gmail") });
    mocks.searchGet.mockImplementation((key: string) => key === "error" ? "provider_failure" : null);
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/could not be completed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to connections" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Return to One" })).toBeNull();
  });

  it("never shows the popup panel to a same-window return, which redirects instead", async () => {
    mocks.readAttempt.mockReturnValue({ ...sameWindowAttempt(), meetingFiles: true, targetAccountId: "default",
      expectedSubjectSha256: "a".repeat(64), priorGrantGeneration: "old", meetingReturn });
    mocks.completeConnect.mockResolvedValue(grantedAccounts());
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/calendar"));
    expect(mocks.settle).not.toHaveBeenCalled();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    expect(screen.queryByTestId("google-oauth-popup-done")).toBeNull();
    expect(mocks.markMeetingReturn).toHaveBeenCalledWith("synthetic-owner", meetingReturn);
  });

  it("does not claim success for a window whose connection was not verified", async () => {
    mocks.readAttempt.mockReturnValue(meetingAttempt());
    mocks.completeConnect.mockResolvedValue({ ...connected(), connected: false });
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 800)); });
    expect(screen.queryByTestId("google-oauth-popup-done")).toBeNull();
    expect(document.body.textContent).not.toContain("Google access saved");
  });
});

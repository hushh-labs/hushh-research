import { StrictMode } from "react";
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
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("GoogleOAuthReturnPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ownerId = "synthetic-owner";
    publishValidatedAuthSessionOwner("synthetic-owner");
    mocks.getIdToken.mockResolvedValue("synthetic-token");
    mocks.completeConnect.mockResolvedValue(connected());
    mocks.readAttempt.mockReturnValue(null);
    mocks.consumeSetupReturn.mockReturnValue(false);
    mocks.searchGet.mockImplementation((key: string) =>
      key === "code"
        ? "synthetic-code"
        : key === "state"
          ? "synthetic-state"
          : null,
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("preserves Calendar routing through neutral completion", async () => {
    render(<GoogleOAuthReturnPage />);
    expect(screen.getByText("Finishing Google connection…")).toBeTruthy();
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/one/calendar"),
    );
    expect(mocks.completeConnect).toHaveBeenCalledWith({
      idToken: "synthetic-token",
      userId: "synthetic-owner",
      code: "synthetic-code",
      state: "synthetic-state",
      isEffectCurrent: expect.any(Function),
    });
  });
  it("preserves Calendar setup only for its own service", async () => {
    mocks.consumeSetupReturn.mockReturnValue(true);
    render(<GoogleOAuthReturnPage />);
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/one/setup/calendar"),
    );
  });
  it("settles an exact Calendar popup attempt", async () => {
    const popup = attempt();
    mocks.readAttempt.mockReturnValue(popup);
    render(<GoogleOAuthReturnPage />);
    await waitFor(() =>
      expect(mocks.settle).toHaveBeenCalledWith(popup, "succeeded"),
    );
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "success" },
    );
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("verifies the added manage account while the default grant is read only", async () => {
    const popup = { ...attempt(), accessLevel: "manage", calendarAdditional: true };
    mocks.readAttempt.mockReturnValue(popup);
    mocks.completeConnect.mockResolvedValue({
      ...connected(),
      access_level: "read",
      completed_account_id: "new-account",
      accounts: [{ account_id: "new-account", connected: true, status: "connected", access_level: "manage" }],
    });

    render(<GoogleOAuthReturnPage />);

    await waitFor(() => expect(mocks.settle).toHaveBeenCalledWith(popup, "succeeded"));
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "success" },
    );
  });
  it("verifies primary account reauthorization from an Add account attempt", async () => {
    const popup = { ...attempt(), accessLevel: "manage", calendarAdditional: true };
    mocks.readAttempt.mockReturnValue(popup);
    mocks.completeConnect.mockResolvedValue({
      ...connected(),
      access_level: "manage",
      completed_account_id: "default",
      accounts: [{ account_id: "default", connected: true, status: "connected", access_level: "manage" }],
    });

    render(<GoogleOAuthReturnPage />);

    await waitFor(() => expect(mocks.settle).toHaveBeenCalledWith(popup, "succeeded"));
  });
  it("settles first Calendar connection when optional meeting consent is partial", async () => {
    const popup = { ...attempt(), meetingFiles: true };
    mocks.readAttempt.mockReturnValue(popup);
    mocks.completeConnect.mockResolvedValue({ ...connected(), scope_csv: "https://www.googleapis.com/auth/calendar.readonly",
      accounts: [{ account_id: "default", connected: true, status: "connected", access_level: "read",
        scope_csv: "https://www.googleapis.com/auth/calendar.readonly" }] });
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.settle).toHaveBeenCalledWith(popup, "succeeded"));
  });
  it.each([
    { completed: "default", scopes: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly https://www.googleapis.com/auth/drive.metadata.readonly", subject: "a".repeat(64), generation: "new", allowed: true },
    { completed: "default", scopes: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly", subject: "a".repeat(64), generation: "new", allowed: false },
    { completed: "other", scopes: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly", subject: "a".repeat(64), generation: "new", allowed: false },
    { completed: "default", scopes: "https://www.googleapis.com/auth/drive.meet.readonly", subject: "a".repeat(64), generation: "new", allowed: false },
    { completed: "default", scopes: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly", subject: "b".repeat(64), generation: "new", allowed: false },
    { completed: "default", scopes: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly", subject: "a".repeat(64), generation: "old", allowed: false },
  ])("verifies the exact default meeting-file grant: $completed/$allowed", async ({ completed, scopes, subject, generation, allowed }) => {
    const popup = { ...attempt(), meetingFiles: true, targetAccountId: "default", expectedSubjectSha256: "a".repeat(64), priorGrantGeneration: "old" };
    mocks.readAttempt.mockReturnValue(popup);
    mocks.completeConnect.mockResolvedValue({ ...connected(), completed_account_id: completed,
      accounts: [{ account_id: completed, connected: true, status: "connected", access_level: "read",
        scope_csv: scopes, provider_subject_sha256: subject, grant_generation: generation }],
    });
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.settle).toHaveBeenCalledWith(popup, allowed ? "succeeded" : "failed", ...(allowed ? [] : [expect.any(String)])));
  });
  it("returns same-window meeting consent to its exact library coordinates", async () => {
    const meetingReturn = { accountId: "default", day: "2026-10-27", timeZone: "Asia/Kolkata", filter: "notes", query: "Growth" };
    const popup = { ...sameWindowAttempt(), meetingFiles: true, targetAccountId: "default", expectedSubjectSha256: "a".repeat(64), priorGrantGeneration: "old", meetingReturn };
    mocks.readAttempt.mockReturnValue(popup);
    mocks.completeConnect.mockResolvedValue({ ...connected(), completed_account_id: "default", accounts: [
      { account_id: "default", connected: true, status: "connected", access_level: "read",
        scope_csv: "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly https://www.googleapis.com/auth/drive.metadata.readonly",
        provider_subject_sha256: "a".repeat(64), grant_generation: "new" },
    ] });
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/one/calendar"));
    expect(mocks.markMeetingReturn).toHaveBeenCalledWith("synthetic-owner", meetingReturn);
  });
  it.each([
    { completed_account_id: undefined, accounts: [{ account_id: "old-account", connected: true, status: "connected", access_level: "manage" }] },
    { completed_account_id: "new-account", accounts: [{ account_id: "old-account", connected: true, status: "connected", access_level: "manage" }] },
  ])("never verifies an additional attempt from an unrelated existing grant: %j", async (completion) => {
    const popup = { ...attempt(), accessLevel: "manage", calendarAdditional: true };
    mocks.readAttempt.mockReturnValue(popup);
    mocks.completeConnect.mockResolvedValue({ ...connected(), access_level: "manage", ...completion });

    render(<GoogleOAuthReturnPage />);

    await waitFor(() => expect(mocks.settle).toHaveBeenCalledWith(
      popup,
      "failed",
      "Google connection could not be verified. Please check connections before trying again.",
    ));
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "error" },
    );
  });
  it.each([undefined, "contacts", "drive"])(
    "rejects unsupported returned service %s",
    async (service) => {
      mocks.completeConnect.mockResolvedValue({ ...connected(), service });
      render(<GoogleOAuthReturnPage />);
      expect(await screen.findByText(/could not be verified/)).toBeTruthy();
      expect(mocks.replace).not.toHaveBeenCalled();
    },
  );
  it("rejects popup service mismatch without changing destination", async () => {
    mocks.readAttempt.mockReturnValue(attempt("drive"));
    render(<GoogleOAuthReturnPage />);
    await waitFor(() =>
      expect(mocks.settle).toHaveBeenCalledWith(
        expect.anything(),
        "failed",
        expect.any(String),
      ),
    );
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("does not report success for an inactive connection", async () => {
    mocks.completeConnect.mockResolvedValue({
      ...connected(),
      connected: false,
    });
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("never copies provider error text into UI or settlement", async () => {
    mocks.readAttempt.mockReturnValue(attempt());
    mocks.searchGet.mockImplementation(
      () => "synthetic-sensitive-provider-detail",
    );
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/could not be completed/)).toBeTruthy();
    expect(document.body.textContent).not.toContain(
      "synthetic-sensitive-provider-detail",
    );
    expect(JSON.stringify(mocks.settle.mock.calls)).not.toContain(
      "synthetic-sensitive-provider-detail",
    );
    expect(mocks.completeConnect).not.toHaveBeenCalled();
  });
  it.each([
    ["access_denied", "expected_error"],
    ["provider_failure", "error"],
  ])("records same-window provider outcome %s exactly once", async (providerError, result) => {
    mocks.readAttempt.mockReturnValue(sameWindowAttempt());
    mocks.searchGet.mockImplementation((key: string) => key === "error" ? providerError : null);
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.trackEvent).toHaveBeenCalledWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result },
    ));
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.clearAttempt).toHaveBeenCalled();
    expect(mocks.completeConnect).not.toHaveBeenCalled();
  });
  it("does not attribute an earlier owner's provider failure to the active owner", async () => {
    mocks.readAttempt.mockReturnValue({
      ...sameWindowAttempt(),
      ownerId: "previous-owner",
    });
    mocks.searchGet.mockImplementation((key: string) =>
      key === "error" ? "access_denied" : null,
    );
    render(<GoogleOAuthReturnPage />);
    expect(await screen.findByText(/same account/)).toBeTruthy();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.clearAttempt).toHaveBeenCalled();
  });
  it("consumes once and still settles under Strict Mode", async () => {
    render(
      <StrictMode>
        <GoogleOAuthReturnPage />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/one/calendar"),
    );
    expect(mocks.completeConnect).toHaveBeenCalledTimes(1);
  });
  it("confirms a timed-out Calendar completion from owner-authenticated status", async () => {
    vi.useFakeTimers();
    mocks.status.mockResolvedValue(connected());
    mocks.completeConnect.mockReturnValue(new Promise(() => {}));
    render(<GoogleOAuthReturnPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_001);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.status).toHaveBeenCalledWith(
      "synthetic-token",
      "synthetic-owner",
    );
    expect(mocks.replace).toHaveBeenCalledWith("/one/calendar");
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "success" },
    );
  });
  it("does not treat a pre-existing read connection as a completed manage upgrade", async () => {
    vi.useFakeTimers();
    mocks.readAttempt.mockReturnValue({
      ...sameWindowAttempt(),
      accessLevel: "manage",
    });
    mocks.status.mockResolvedValue({
      ...connected(),
      access_level: "read",
    });
    mocks.completeConnect.mockReturnValue(new Promise(() => {}));
    render(<GoogleOAuthReturnPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_001);
      await Promise.resolve();
    });

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "error" },
    );
  });
  it("does not turn a timed-out additional attempt into success from the default grant", async () => {
    vi.useFakeTimers();
    mocks.readAttempt.mockReturnValue({ ...attempt(), accessLevel: "manage", calendarAdditional: true });
    mocks.status.mockResolvedValue({ ...connected(), access_level: "manage" });
    mocks.completeConnect.mockReturnValue(new Promise(() => {}));

    render(<GoogleOAuthReturnPage />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_001);
    });

    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.anything(),
      "failed",
      "Google may still be saving this connection. Check connections before starting again.",
    );
  });
  it("rejects an immediate read-only result for a manage upgrade", async () => {
    mocks.readAttempt.mockReturnValue({
      ...sameWindowAttempt(),
      accessLevel: "manage",
    });
    mocks.completeConnect.mockResolvedValue({
      ...connected(),
      access_level: "read",
    });

    render(<GoogleOAuthReturnPage />);

    expect(await screen.findByText(/could not be verified/)).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      { route_id: "one_calendar", action: "connected", result: "error" },
    );
  });
  it("does not exchange the code after account change while awaiting identity", async () => {
    const token = pending<string>();
    mocks.getIdToken.mockReturnValue(token.promise);
    const view = render(<GoogleOAuthReturnPage />);
    mocks.ownerId = "other-owner";
    view.rerender(<GoogleOAuthReturnPage />);
    await act(async () => {
      token.resolve("synthetic-token");
    });
    expect(mocks.completeConnect).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("drops late success across owner A to B to A", async () => {
    const result = pending<ReturnType<typeof connected>>();
    mocks.completeConnect.mockReturnValue(result.promise);
    const view = render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.completeConnect).toHaveBeenCalledTimes(1));
    mocks.ownerId = "other-owner";
    view.rerender(<GoogleOAuthReturnPage />);
    mocks.ownerId = "synthetic-owner";
    view.rerender(<GoogleOAuthReturnPage />);
    await act(async () => {
      result.resolve(connected());
    });
    expect(mocks.replace).not.toHaveBeenCalled();
  });
  it("does not dispatch after unmount during identity lookup", async () => {
    const token = pending<string>();
    mocks.getIdToken.mockReturnValue(token.promise);
    const view = render(<GoogleOAuthReturnPage />);
    view.unmount();
    await act(async () => {
      token.resolve("synthetic-token");
    });
    expect(mocks.completeConnect).not.toHaveBeenCalled();
  });
});

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

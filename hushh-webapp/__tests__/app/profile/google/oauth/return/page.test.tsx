import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  searchGet: vi.fn(),
  completeConnect: vi.fn(),
  status: vi.fn(),
  consumeSetupReturn: vi.fn(),
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
    loading: false,
  }),
}));
vi.mock("@/lib/calendar/calendar-oauth-journey", () => ({
  consumeCalendarSetupOAuthReturn: mocks.consumeSetupReturn,
}));
vi.mock("@/lib/services/google-connection-service", () => ({
  GoogleConnectionService: { completeConnect: mocks.completeConnect },
}));
vi.mock("@/lib/services/google-calendar-service", () => ({
  GoogleCalendarService: { status: mocks.status },
}));
vi.mock("@/lib/google/google-oauth-popup", () => ({
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
    expect(mocks.clearAttempt).toHaveBeenCalledOnce();
    expect(mocks.completeConnect).not.toHaveBeenCalled();
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

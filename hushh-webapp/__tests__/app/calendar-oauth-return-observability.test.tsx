import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import GoogleOAuthReturnPage from "@/app/profile/google/oauth/return/page";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  trackEvent: vi.fn(),
  settle: vi.fn(),
  readAttempt: vi.fn().mockReturnValue(null),
  completeConnect: vi.fn().mockResolvedValue({
    service: "calendar",
    connected: true,
    status: "connected",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams("code=valid-code&state=valid-state"),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    loading: false,
    user: { uid: "owner", getIdToken: async () => "owner-token" },
  }),
}));
vi.mock("@/lib/auth/session-owner", () => ({
  snapshotValidatedAuthSessionOwner: () => ({ userId: "owner" }),
  isValidatedAuthSessionOwnerCurrent: () => true,
}));
vi.mock("@/lib/calendar/calendar-oauth-journey", () => ({
  consumeCalendarSetupOAuthReturn: () => false,
}));
vi.mock("@/lib/google/google-oauth-popup", () => ({
  readGoogleOAuthPopupAttempt: mocks.readAttempt,
  settleGoogleOAuthPopup: mocks.settle,
}));
vi.mock("@/lib/services/google-connection-service", () => ({
  GoogleConnectionService: { completeConnect: mocks.completeConnect },
}));
vi.mock("@/lib/observability/client", () => ({
  trackEvent: mocks.trackEvent,
}));
vi.mock("@/components/app-ui/hushh-loader", () => ({
  HushhLoader: () => <div>Finishing connection</div>,
}));

describe("Calendar same-window OAuth observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAttempt.mockReturnValue(null);
  });

  it("counts a verified same-window connection once before returning to Calendar", async () => {
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.replace).toHaveBeenCalled());
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith("one_calendar_action", {
      route_id: "one_calendar",
      action: "connected",
      result: "success",
    });
  });

  it("owns popup completion telemetry before notifying the workspace", async () => {
    mocks.readAttempt.mockReturnValue({ service: "calendar", attemptId: "attempt-1" });
    render(<GoogleOAuthReturnPage />);
    await waitFor(() => expect(mocks.settle).toHaveBeenCalled());
    expect(mocks.trackEvent).toHaveBeenCalledExactlyOnceWith(
      "one_calendar_action",
      {
        route_id: "one_calendar",
        action: "connected",
        result: "success",
      },
    );
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

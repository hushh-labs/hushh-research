import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  historyReplace: vi.fn(),
  search: "",
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/components/onboarding/AuthStep", () => ({
  AuthStep: ({ redirectPath }: { redirectPath: string }) => (
    <div data-testid="redirect-path">{redirectPath || "organic"}</div>
  ),
}));

vi.mock("@/components/app-ui/native-route-marker", () => ({
  NativeRouteMarker: () => null,
}));

import LoginPage from "@/app/login/page";

describe("login terminal-session notice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.historyReplace.mockReset();
    vi.spyOn(window.history, "replaceState").mockImplementation(
      mocks.historyReplace,
    );
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.search = "";
  });

  it("shows account-not-found once and consumes only its query parameter", async () => {
    mocks.search = "redirect=%2Fone%2Ffeed&auth_notice=account_not_found";

    render(
      <StrictMode>
        <LoginPage />
      </StrictMode>,
    );

    expect(screen.getByTestId("redirect-path").textContent).toBe("/one/feed");
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(1);
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Account not found. Redirecting you to login screen.",
        { id: "auth-session-account-not-found" },
      );
      expect(mocks.historyReplace).toHaveBeenCalledTimes(1);
      expect(mocks.historyReplace).toHaveBeenCalledWith(
        window.history.state,
        "",
        "/login?redirect=%2Fone%2Ffeed",
      );
    });
  });

  it("uses neutral copy for a generic invalid session", async () => {
    mocks.search = "auth_notice=session_invalid";

    render(<LoginPage />);

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Your session is no longer valid. Please sign in again.",
        { id: "auth-session-invalid" },
      ),
    );
    expect(mocks.historyReplace).toHaveBeenCalledWith(
      window.history.state,
      "",
      "/login",
    );
  });

  it("confirms deletion to the initiating client after secure sign-out", async () => {
    mocks.search = "auth_notice=account_deleted";

    render(<LoginPage />);

    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Account deleted. You have been securely signed out.",
        { id: "auth-session-account-deleted" },
      ),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.historyReplace).toHaveBeenCalledWith(
      window.history.state,
      "",
      "/login",
    );
  });

  it("explains a fail-closed sign-out without claiming uncertain deletion succeeded", async () => {
    mocks.search = "auth_notice=account_deletion_uncertain";

    render(<LoginPage />);

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "We couldn't confirm whether account deletion finished. For your security, we signed you out and won't retry it automatically. Please check your connection before signing in again.",
        { id: "auth-session-account-deletion-uncertain" },
      ),
    );
    expect(mocks.historyReplace).toHaveBeenCalledWith(
      window.history.state,
      "",
      "/login",
    );
  });

  it("silently scrubs an untrusted notice value", async () => {
    mocks.search = "auth_notice=raw+backend+failure";

    render(<LoginPage />);

    await waitFor(() =>
      expect(mocks.historyReplace).toHaveBeenCalledWith(
        window.history.state,
        "",
        "/login",
      ),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("leaves an organic login URL alone", () => {
    render(<LoginPage />);

    expect(screen.getByTestId("redirect-path").textContent).toBe("organic");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.historyReplace).not.toHaveBeenCalled();
  });
});

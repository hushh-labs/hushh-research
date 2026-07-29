import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { SessionTimeoutWarning } from "@/components/app-ui/session-timeout-warning";

describe("SessionTimeoutWarning Component - Security & A11y", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders with strict alertdialog ARIA roles", () => {
    const { getByRole } = render(
      <SessionTimeoutWarning onLogout={vi.fn()} onExtendSession={vi.fn()} />
    );
    const dialog = getByRole("alertdialog");
    expect(dialog).toBeDefined();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("session-warning-title");
  });

  it("formats the initial countdown correctly and renders critical text", () => {
    const { getByText } = render(
      <SessionTimeoutWarning onLogout={vi.fn()} onExtendSession={vi.fn()} countdownSeconds={65} />
    );
    // 65 seconds should format to 1:05
    expect(getByText("1:05")).toBeDefined();
    expect(getByText("Session Expiring Soon")).toBeDefined();
  });

  it("triggers the onLogout callback when the timer reaches zero", () => {
    const onLogoutMock = vi.fn();
    render(<SessionTimeoutWarning onLogout={onLogoutMock} onExtendSession={vi.fn()} countdownSeconds={5} />);

    expect(onLogoutMock).not.toHaveBeenCalled();

    // Advance time by 5 seconds
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onLogoutMock).toHaveBeenCalledOnce();
  });

  it("triggers onExtendSession when the primary button is clicked", () => {
    const onExtendMock = vi.fn();
    const { getByText } = render(
      <SessionTimeoutWarning onLogout={vi.fn()} onExtendSession={onExtendMock} />
    );

    const extendBtn = getByText("Stay signed in");
    fireEvent.click(extendBtn);

    expect(onExtendMock).toHaveBeenCalledOnce();
  });
});
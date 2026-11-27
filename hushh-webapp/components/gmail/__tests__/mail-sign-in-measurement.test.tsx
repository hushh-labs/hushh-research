import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useMailSignInMeasurement } from "@/components/gmail/use-mail-sign-in-measurement";

const { snapshotOwner, trackEvent } = vi.hoisted(() => ({
  snapshotOwner: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/auth/session-owner", () => ({
  snapshotValidatedAuthSessionOwner: snapshotOwner,
}));
vi.mock("@/lib/observability/client", () => ({ trackEvent }));

describe("Mail sign-in measurement", () => {
  beforeEach(() => {
    trackEvent.mockClear();
    snapshotOwner.mockReturnValue({ userId: "owner" });
  });

  it("counts one view per visit, despite visibility changes", () => {
    const { rerender, unmount } = renderHook(
      (visible) => useMailSignInMeasurement("owner", visible),
      { initialProps: false },
    );
    expect(trackEvent).not.toHaveBeenCalled();

    rerender(true);
    rerender(false);
    rerender(true);
    expect(trackEvent).toHaveBeenCalledExactlyOnceWith(
      "hushh_mail_signin_screen_view",
      { result: "success" },
    );

    unmount();
    renderHook(() => useMailSignInMeasurement("owner", true));
    expect(trackEvent).toHaveBeenCalledTimes(2);
  });

  it("requires the current verified owner and supports account changes", () => {
    const { rerender } = renderHook(
      (userId: string | null) => useMailSignInMeasurement(userId, true),
      { initialProps: "stale-owner" },
    );
    expect(trackEvent).not.toHaveBeenCalled();

    rerender("owner");
    expect(trackEvent).toHaveBeenCalledTimes(1);

    snapshotOwner.mockReturnValue(null);
    rerender(null);
    rerender("another-owner");
    expect(trackEvent).toHaveBeenCalledTimes(1);

    snapshotOwner.mockReturnValue({ userId: "another-owner" });
    rerender(null);
    rerender("another-owner");
    expect(trackEvent).toHaveBeenCalledTimes(2);
  });
});

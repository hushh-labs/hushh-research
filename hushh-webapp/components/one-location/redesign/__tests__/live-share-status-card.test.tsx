import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LiveShareStatusCard,
  ShareCountdownText,
  liveShareTitle,
  type LiveShareStatus,
} from "@/components/one-location/redesign/live-share-status-card";

const NOW = Date.parse("2026-08-16T10:00:00.000Z");

function status(overrides: Partial<LiveShareStatus> = {}): LiveShareStatus {
  return {
    count: 1,
    grantCount: 1,
    names: ["Rohan Mehta"],
    startedAt: "2026-08-16T09:30:00.000Z",
    endsAt: "2026-08-16T11:00:00.000Z",
    stoppableGrantId: "grant_1",
    ...overrides,
  };
}

function countdown(): string {
  return (
    screen.getByTestId("one-location-live-share-countdown").textContent ?? ""
  );
}

describe("LiveShareStatusCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams the remaining time second by second", () => {
    // The whole point of the fix: a share set for an hour must visibly count
    // down, not print one value and freeze.
    render(
      <LiveShareStatusCard
        status={status({ endsAt: "2026-08-16T10:47:05.000Z" })}
        onManage={vi.fn()}
      />,
    );

    expect(countdown()).toBe("47:05");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdown()).toBe("47:04");

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(countdown()).toBe("46:59");
  });

  it("catches up in one frame after the app comes back from the background", () => {
    // iOS throttles timers in a suspended web view. Without the resume resync
    // the clock shows whatever value it froze at — the exact "my share time
    // didn't move" symptom.
    render(
      <LiveShareStatusCard
        status={status({ endsAt: "2026-08-16T10:47:05.000Z" })}
        onManage={vi.fn()}
      />,
    );
    expect(countdown()).toBe("47:05");

    act(() => {
      vi.setSystemTime(NOW + 10 * 60 * 1000);
      window.dispatchEvent(new Event("focus"));
    });

    expect(countdown()).toBe("37:05");
  });

  it("stops ticking while the screen is hidden and resyncs when it returns", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    render(
      <LiveShareStatusCard
        status={status({ endsAt: "2026-08-16T10:47:05.000Z" })}
        onManage={vi.fn()}
      />,
    );

    act(() => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
    });
    expect(countdown()).toBe("47:05");

    act(() => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(countdown()).toBe("46:05");

    visibility.mockRestore();
  });

  it("tells assistive tech the time in words, not once a second", () => {
    render(
      <LiveShareStatusCard
        status={status({ endsAt: "2026-08-16T10:47:05.000Z" })}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText("47 minutes left")).toBeTruthy();
    // The moving digits are hidden from screen readers so they are not
    // re-announced on every tick.
    expect(
      screen
        .getByTestId("one-location-live-share-countdown")
        .getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("reports the running total for a share that lasts until you stop it", () => {
    render(
      <LiveShareStatusCard
        status={status({ endsAt: null })}
        onManage={vi.fn()}
      />,
    );

    expect(countdown()).toBe("30:00");
    expect(screen.getByText("so far")).toBeTruthy();
    expect(screen.getByText("Until you stop")).toBeTruthy();
  });

  it("names the person when the server state is loaded", () => {
    render(<LiveShareStatusCard status={status()} onManage={vi.fn()} />);
    expect(screen.getByText("Sharing with Rohan Mehta")).toBeTruthy();
  });

  it("still reports the share on a cold start, before any name is known", () => {
    // Names are never persisted, so a first paint from the device record has
    // the count and nothing else. It must still say something true.
    render(
      <LiveShareStatusCard
        status={status({
          count: 2,
          grantCount: 2,
          names: [],
          stoppableGrantId: null,
        })}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText("Sharing with 2 people")).toBeTruthy();
    expect(screen.queryByTestId("one-location-live-share-countdown")).toBeNull();
    expect(screen.getByText("Different end times")).toBeTruthy();
  });

  it("offers Stop for a single share and Manage for several", () => {
    const onStop = vi.fn();
    const onManage = vi.fn();
    const { rerender } = render(
      <LiveShareStatusCard
        status={status()}
        onManage={onManage}
        onStop={onStop}
      />,
    );

    screen.getByRole("button", { name: "Stop" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(
      <LiveShareStatusCard
        status={status({
          count: 3,
          grantCount: 3,
          names: ["A", "B", "C"],
          stoppableGrantId: null,
        })}
        onManage={onManage}
      />,
    );
    screen.getByRole("button", { name: "Manage" }).click();
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("offers Manage for one person who holds two share lanes", () => {
    const onManage = vi.fn();
    render(
      <LiveShareStatusCard
        status={status({
          count: 1,
          grantCount: 2,
          names: ["Rohan Mehta"],
          stoppableGrantId: null,
          endsAt: "2026-08-16T18:00:00.000Z",
        })}
        onManage={onManage}
      />,
    );

    expect(screen.getByText("Sharing with Rohan Mehta")).toBeTruthy();
    expect(screen.getByText("2 active shares")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    screen.getByRole("button", { name: "Manage" }).click();
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("offers Change end time on a single share after the primary share action", () => {
    // The reported bug: a 30-minute share could be stopped and nothing else.
    // The control has to be there, but the compact Now card keeps it below the
    // primary "Share with more" CTA instead of exposing the duration editor on
    // the page.
    const onChangeDuration = vi.fn();
    render(
      <LiveShareStatusCard
        status={status()}
        onManage={vi.fn()}
        onStop={vi.fn()}
        onChangeDuration={onChangeDuration}
        onShareMore={vi.fn()}
      />,
    );

    const change = screen.getByRole("button", { name: "Change end time" });
    change.click();
    expect(onChangeDuration).toHaveBeenCalledTimes(1);
    expect(onChangeDuration).toHaveBeenCalledWith(change);

    expect(screen.getByText(/^Ends /)).toBeTruthy();
    const shareMore = screen.getByRole("button", { name: "Share with more" });
    expect(
      (shareMore.compareDocumentPosition(change) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0,
    ).toBe(true);
  });

  it("opens the share composer from the live timer card for another share", () => {
    const onShareMore = vi.fn();
    render(
      <LiveShareStatusCard
        status={status()}
        onManage={vi.fn()}
        onStop={vi.fn()}
        onShareMore={onShareMore}
      />,
    );

    screen.getByRole("button", { name: "Share with more" }).click();
    expect(onShareMore).toHaveBeenCalledTimes(1);
  });

  it("only opens manage from the visible Manage control", () => {
    const onManage = vi.fn();
    render(
      <LiveShareStatusCard
        status={status()}
        onManage={onManage}
        onStop={vi.fn()}
        onChangeDuration={vi.fn()}
        onShareMore={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Your live location share" }),
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Stop" }), {
      key: "Enter",
    });
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Change end time" }),
      {
        key: " ",
      },
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Share with more" }), {
      key: "Enter",
    });

    expect(onManage).not.toHaveBeenCalled();
  });

  it("hides Change end time when there is no single share to change", () => {
    // Same gate as Stop. With three shares running "change the time" has no
    // referent, and the card must not offer to act on an unnamed one.
    render(
      <LiveShareStatusCard
        status={status({
          count: 3,
          grantCount: 3,
          names: ["A", "B", "C"],
          stoppableGrantId: null,
        })}
        onManage={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Change end time" }),
    ).toBeNull();
    expect(screen.getByText("Different end times")).toBeTruthy();
  });

  it("summarizes end times honestly when several shares run", () => {
    const { unmount } = render(
      <LiveShareStatusCard
        status={status()}
        onManage={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    // One share: the end time is simply the end time.
    expect(screen.getByText(/^Ends /)).toBeTruthy();
    expect(screen.queryByText(/^Last ends /)).toBeNull();
    unmount();

    render(
      <LiveShareStatusCard
        status={status({
          count: 2,
          grantCount: 2,
          names: ["A", "B"],
          stoppableGrantId: null,
          timeSummary: {
            kind: "same_timed",
            endsAt: "2026-08-16T11:00:00.000Z",
          },
        })}
        onManage={vi.fn()}
      />,
    );
    expect(screen.getByText(/^All end at /)).toBeTruthy();
  });

  it("offers Set an end time on an open-ended ordinary share", () => {
    // "Until you stop" is the footer here, not an end time. The action still
    // belongs: giving an open share a finite end is exactly a time change.
    const onChangeDuration = vi.fn();
    render(
      <LiveShareStatusCard
        status={status({ endsAt: null })}
        onManage={vi.fn()}
        onStop={vi.fn()}
        onChangeDuration={onChangeDuration}
      />,
    );

    screen.getByRole("button", { name: "Set an end time" }).click();
    expect(onChangeDuration).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Until you stop")).toBeTruthy();
  });

  it("tells the page exactly once when the share runs out", () => {
    const onEnded = vi.fn();
    render(
      <LiveShareStatusCard
        status={status({ endsAt: "2026-08-16T10:00:03.000Z" })}
        onManage={vi.fn()}
        onEnded={onEnded}
      />,
    );

    expect(onEnded).not.toHaveBeenCalled();

    act(() => {
      vi.setSystemTime(NOW + 4000);
      vi.advanceTimersByTime(4000);
    });
    expect(countdown()).toBe("00:00");
    expect(onEnded).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onEnded).toHaveBeenCalledTimes(1);
  });
});

describe("liveShareTitle", () => {
  it("never renders a bare number", () => {
    expect(liveShareTitle(status())).toBe("Sharing with Rohan Mehta");
    expect(liveShareTitle(status({ names: ["A", "B"] }))).toBe(
      "Sharing with 2 people",
    );
    expect(liveShareTitle(status({ names: [], count: 1 }))).toBe(
      "Sharing with 1 person",
    );
    expect(liveShareTitle(status({ names: [], count: 4 }))).toBe(
      "Sharing with 4 people",
    );
  });
});

describe("ShareCountdownText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps each person's row counting down too", () => {
    render(<ShareCountdownText expiresAt="2026-08-16T10:12:30.000Z" />);
    expect(screen.getByText("12:30 left")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText("12:00 left")).toBeTruthy();
  });

  it("says so plainly once the window closes", () => {
    render(<ShareCountdownText expiresAt="2026-08-16T10:00:01.000Z" />);
    act(() => {
      vi.setSystemTime(NOW + 2000);
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("Stopping now")).toBeTruthy();
  });

  it("falls back without an expiry rather than rendering an empty row", () => {
    render(<ShareCountdownText expiresAt={null} />);
    expect(screen.getByText("Active")).toBeTruthy();
  });
});

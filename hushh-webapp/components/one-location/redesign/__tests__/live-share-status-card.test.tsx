import { act, render, screen } from "@testing-library/react";
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
    names: ["Rohan Mehta"],
    startedAt: "2026-08-16T09:30:00.000Z",
    endsAt: "2026-08-16T11:00:00.000Z",
    stoppableGrantId: "grant_1",
    ...overrides,
  };
}

function countdown(): string {
  return screen.getByTestId("one-location-live-share-countdown").textContent ?? "";
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

  it("fills the progress bar with the time already spent", () => {
    // Started 09:30, ends 11:00, now 10:00 — a third of the way through.
    render(<LiveShareStatusCard status={status()} onManage={vi.fn()} />);

    const bar = screen.getByTestId("one-location-live-share-progress");
    expect(bar.getAttribute("style")).toContain("width: 33%");
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
    expect(screen.queryByTestId("one-location-live-share-progress")).toBeNull();
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
        status={status({ count: 2, names: [], stoppableGrantId: null })}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText("Sharing with 2 people")).toBeTruthy();
    expect(countdown()).toBe("1h 00m");
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
        status={status({ count: 3, names: ["A", "B", "C"], stoppableGrantId: null })}
        onManage={onManage}
      />,
    );
    screen.getByRole("button", { name: "Manage" }).click();
    expect(onManage).toHaveBeenCalledTimes(1);
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

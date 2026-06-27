import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FocusTimerWidget } from "@/components/features/focus/focus-timer-widget";
import { useFocusTimer } from "@/lib/hooks/use-focus-timer";

vi.mock("@/lib/hooks/use-focus-timer", () => ({
  useFocusTimer: vi.fn(),
}));

describe("FocusTimerWidget", () => {
  it("covers timer toggle button type", () => {
    vi.mocked(useFocusTimer).mockReturnValue({
      isOpen: true,
      timeLeft: 25 * 60,
      isRunning: false,
      mode: "pomodoro",
      sessionsCompleted: 0,
      setIsOpen: vi.fn(),
      toggleTimer: vi.fn(),
      resetTimer: vi.fn(),
      setMode: vi.fn(),
      tick: vi.fn(),
    });

    render(<FocusTimerWidget />);

    expect(
      screen.getByRole("button", { name: "Start" }).getAttribute("type"),
    ).toBe("button");
  });
});

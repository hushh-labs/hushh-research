import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const mockProgressState = vi.hoisted(() => ({
  progress: 42,
  isLoading: true,
}));

vi.mock("@/lib/progress/step-progress-context", () => ({
  useStepProgress: () => ({
    registerSteps: vi.fn(),
    completeStep: vi.fn(),
    reset: vi.fn(),
    progress: mockProgressState.progress,
    isLoading: mockProgressState.isLoading,
    beginTask: vi.fn(),
    completeTaskStep: vi.fn(),
    endTask: vi.fn(),
  }),
}));

import { StepProgressBar } from "@/components/app-ui/step-progress-bar";

describe("StepProgressBar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Default mock state
    mockProgressState.progress = 42;
    mockProgressState.isLoading = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders progress aria value bounds", () => {
    render(<StepProgressBar />);

    const progressbar = screen.getByRole("progressbar", {
      name: "Page loading",
    });

    expect(progressbar.getAttribute("aria-valuemin")).toBe("0");
    expect(progressbar.getAttribute("aria-valuemax")).toBe("100");
    expect(progressbar.getAttribute("aria-valuenow")).toBe("42");
    expect(progressbar.getAttribute("aria-valuetext")).toBe("42%");
  });

  it("renders nothing (returns null) when not loading and progress is 0", () => {
    mockProgressState.isLoading = false;
    mockProgressState.progress = 0;

    const { container } = render(<StepProgressBar />);
    expect(container.firstChild).toBeNull();
  });

  it("completes progress, fades out, and resets after timeouts", () => {
    const { rerender } = render(<StepProgressBar />);

    // Renders progress bar at 42%
    expect(screen.queryByRole("progressbar")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("42");

    // Complete loading (progress: 100, isLoading: false)
    mockProgressState.isLoading = false;
    mockProgressState.progress = 100;

    act(() => {
      rerender(<StepProgressBar />);
    });

    // Visually it should reach 100% first
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");

    // Run 500ms timers for the first fade-out timeout
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Should be fading out / visible=false, but progress not yet reset to 0
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");

    // Run 300ms timers for the final reset timeout
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // Now progress is reset, and the bar is unmounted
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("resets immediately on hard reset (progress: 0)", () => {
    const { rerender } = render(<StepProgressBar />);

    expect(screen.queryByRole("progressbar")).not.toBeNull();

    // Trigger a hard reset (progress: 0, isLoading: false)
    mockProgressState.isLoading = false;
    mockProgressState.progress = 0;

    act(() => {
      rerender(<StepProgressBar />);
    });

    // Unmounts immediately without timeout sequence
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

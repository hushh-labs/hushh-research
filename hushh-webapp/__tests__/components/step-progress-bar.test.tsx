import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});

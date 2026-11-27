import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  ONE_PERSONA_THINKING_PHRASES,
  ONE_TURN_PHASE_LABELS,
  OneThinkingIndicator,
} from "@/components/agent/one-thinking-indicator";

describe("OneThinkingIndicator honest lifecycle labels", () => {
  it("never emits speculative rotating phrases and reflects the exact runtime phase", () => {
    expect(ONE_PERSONA_THINKING_PHRASES).toEqual([ONE_TURN_PHASE_LABELS.thinking]);

    const { rerender } = render(<OneThinkingIndicator phase="waking" />);
    expect(screen.getByTestId("one-thinking-indicator")).toHaveAttribute(
      "data-turn-phase",
      "waking",
    );
    expect(screen.getByText("Waking your sandbox…")).toBeTruthy();
    expect(screen.queryByText(/Distilling context|Consulting your wiki/i)).toBeNull();

    rerender(<OneThinkingIndicator phase="unlocking" />);
    expect(screen.getByText("Unlocking memory…")).toBeTruthy();

    rerender(<OneThinkingIndicator phase="reconnecting" />);
    expect(screen.getByText("Reconnecting to One…")).toBeTruthy();

    rerender(<OneThinkingIndicator phase="thinking" />);
    expect(screen.getByText("Thinking…")).toBeTruthy();

    rerender(<OneThinkingIndicator phase="working" label="Checking calendar availability…" />);
    expect(screen.getByText("Checking calendar availability…")).toBeTruthy();
  });
});

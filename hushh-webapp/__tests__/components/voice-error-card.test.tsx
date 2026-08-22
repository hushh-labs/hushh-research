import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceErrorCard } from "@/components/agent/voice-error-card";

describe("VoiceErrorCard", () => {
  it("renders nothing without a message", () => {
    render(<VoiceErrorCard message={null} onRetry={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId("voice-error-card")).toBeNull();
  });

  it("shows the full reason, not truncated", () => {
    const longMessage =
      "Microphone access is blocked. Allow the mic in your browser or system settings, then try again.";
    render(<VoiceErrorCard message={longMessage} onRetry={() => {}} onClose={() => {}} />);

    expect(screen.getByText(longMessage)).toBeInTheDocument();
  });

  it("Close calls the handler", () => {
    const onClose = vi.fn();
    render(
      <VoiceErrorCard
        message="Voice took too long to start."
        onRetry={() => {}}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Try again calls the retry handler", () => {
    const onRetry = vi.fn();
    render(
      <VoiceErrorCard
        message="Voice took too long to start."
        onRetry={onRetry}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  VoiceErrorCard,
  isMicPermissionError,
  voiceErrorTitle,
} from "@/components/one-voice/voice-error-card";

afterEach(() => cleanup());

describe("VoiceErrorCard", () => {
  it("is an alert with the full message and a retry", () => {
    const onRetry = vi.fn();
    render(
      <VoiceErrorCard
        error={{
          code: "capacity",
          message: "Voice is busy right now. Try again in a moment.",
          recoverable: false,
        }}
        onRetry={onRetry}
      />,
    );
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("Voice is busy");
    expect(card).toHaveTextContent(
      "Voice is busy right now. Try again in a moment.",
    );
    fireEvent.click(screen.getByTestId("one-voice-error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("one-voice-error-open-settings")).toBeNull();
  });

  it("exposes the OS settings action for a microphone-permission error", () => {
    const onOpenSettings = vi.fn();
    render(
      <VoiceErrorCard
        error={{
          code: "not_allowed",
          message: "Microphone access is blocked.",
          recoverable: false,
        }}
        onRetry={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Microphone access is blocked",
    );
    fireEvent.click(screen.getByTestId("one-voice-error-open-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("never offers settings for a non-permission error even when a handler is passed", () => {
    render(
      <VoiceErrorCard
        error={{
          code: "voice_unavailable",
          message: "Voice is unavailable right now.",
          recoverable: false,
        }}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("one-voice-error-open-settings")).toBeNull();
    expect(screen.queryByTestId("one-voice-error-retry")).toBeNull();
  });

  it("dismisses through the 44pt close control", () => {
    const onDismiss = vi.fn();
    render(
      <VoiceErrorCard
        error={{
          code: "replaced",
          message: "Voice moved to another device or tab.",
          recoverable: false,
        }}
        onDismiss={onDismiss}
      />,
    );
    const close = screen.getByTestId("one-voice-error-dismiss");
    expect(close.className).toContain("h-11");
    expect(close.className).toContain("w-11");
    fireEvent.click(close);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("classifies permission codes and titles", () => {
    expect(isMicPermissionError("not_allowed")).toBe(true);
    expect(isMicPermissionError("mic_permission_denied")).toBe(true);
    expect(isMicPermissionError("not_found")).toBe(false);
    expect(isMicPermissionError(null)).toBe(false);
    expect(voiceErrorTitle({ code: "not_found" })).toBe("No microphone found");
    expect(voiceErrorTitle({ code: "closed_1006" })).toBe(
      "Voice couldn't continue",
    );
  });
});

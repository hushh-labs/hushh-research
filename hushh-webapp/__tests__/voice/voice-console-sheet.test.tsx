import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { VoiceConsoleSheet } from "@/components/kai/voice/voice-console-sheet";

vi.mock("lucide-react", () => ({
  Mic: () => null,
  MicOff: () => null,
  Send: () => null,
  X: () => null,
}));

describe("voice-console-sheet", () => {
  it("uses mute/unmute controls instead of pause/resume", () => {
    render(
      <VoiceConsoleSheet
        open
        muted={false}
        submitting={false}
        transcriptPreview="Listening..."
        smoothedLevel={0}
        onMuteToggle={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onExamplePrompt={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Mute" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("keeps a separate cancel control for ending the session", () => {
    const onCancel = vi.fn();
    render(
      <VoiceConsoleSheet
        open
        muted
        submitting={false}
        transcriptPreview="Microphone muted."
        smoothedLevel={0}
        onMuteToggle={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={onCancel}
        onExamplePrompt={vi.fn()}
      />
    );

    fireEvent.click(screen.getByLabelText("End voice session"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Unmute" })).toBeTruthy();
  });
});

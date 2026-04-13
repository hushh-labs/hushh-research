import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { VoiceDebugDrawer } from "@/components/kai/voice/voice-debug-drawer";

const clearDebugEventsMock = vi.fn();
const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const writeTextMock = vi.fn();

const debugStore = {
  debugEvents: [
    {
      id: "evt_1",
      turnId: "turn_1",
      sessionId: "sess_1",
      stage: "stt" as const,
      event: "session_state_changed",
      timestamp: "2026-04-03T00:00:00.000Z",
      payload: {
        state: "connected",
      },
    },
  ],
  clearDebugEvents: clearDebugEventsMock,
  lastTurnId: "turn_1",
};

vi.mock("lucide-react", () => ({
  Bug: () => null,
  ChevronDown: () => null,
  ChevronUp: () => null,
  Copy: () => null,
  Trash2: () => null,
}));

vi.mock("@/lib/voice/voice-session-store", () => ({
  useVoiceSession: (selector: (value: typeof debugStore) => unknown) => selector(debugStore),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

describe("voice-debug-drawer", () => {
  beforeEach(() => {
    clearDebugEventsMock.mockReset();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  it("copies the current debug payload to the clipboard", async () => {
    render(
      <VoiceDebugDrawer
        enabled
        currentState="idle"
        sessionId="vsession_1"
        route="/kai"
        screen="kai_market"
        authStatus="signed_in"
        vaultStatus="unlocked_valid"
        voiceAvailabilityReason="available"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /^Voice Debug$/i }));
    fireEvent.click(screen.getByLabelText("Copy voice debug"));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
    });
    const copied = writeTextMock.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain('"state": "idle"');
    expect(copied).toContain('"route": "/kai"');
    expect(copied).toContain('"event": "session_state_changed"');
    expect(toastSuccessMock).toHaveBeenCalledWith("Voice debug copied");
  });
});

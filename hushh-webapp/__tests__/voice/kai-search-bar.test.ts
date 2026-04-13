import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

vi.mock("lucide-react", () => ({
  Bug: () => null,
  Loader2: () => null,
  Mic: () => null,
  Search: () => null,
}));

vi.mock("@/components/kai/kai-command-palette", () => ({
  KaiCommandPalette: () => null,
}));

vi.mock("@/components/kai/voice/voice-compact-status", () => ({
  VoiceCompactStatus: ({
    mode,
    label,
    stageText,
  }: {
    mode: string;
    label?: string;
    stageText?: string | null;
  }) =>
    createElement(
      "div",
      { "data-testid": "voice-compact-status", "data-mode": mode },
      label || "",
      stageText || ""
    ),
}));

vi.mock("@/components/kai/voice/voice-console-sheet", () => ({
  VoiceConsoleSheet: ({
    open,
    muted,
    transcriptPreview,
    onCancel,
  }: {
    open: boolean;
    muted: boolean;
    transcriptPreview: string;
    onCancel: () => void;
  }) =>
    open
      ? createElement(
          "div",
          {
          "data-testid": "voice-console-sheet",
            "data-muted": muted ? "true" : "false",
          },
          createElement("div", { "data-testid": "voice-console-preview" }, transcriptPreview),
          createElement(
            "button",
            { type: "button", onClick: onCancel },
            "cancel voice"
          )
        )
      : null,
}));

vi.mock("@/components/kai/voice/voice-debug-drawer", () => ({
  VoiceDebugDrawer: () => null,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) =>
    createElement("button", { type: "button", onClick }, children),
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/morphy-ux/ui", () => ({
  Icon: () => createElement("span"),
}));

vi.mock("@/lib/navigation/kai-bottom-chrome-visibility", () => ({
  useKaiBottomChromeVisibility: () => ({
    hidden: false,
    progress: 0,
  }),
}));

vi.mock("@/lib/navigation/kai-command-bar-events", () => ({
  KAI_COMMAND_BAR_OPEN_EVENT: "kai-open",
}));

vi.mock("@/lib/utils", () => ({
  cn: (...values: Array<string | boolean | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    getVaultOwnerToken: () => "vault_token",
  }),
}));

vi.mock("@/lib/voice/use-amplitude-meter", () => ({
  useAmplitudeMeter: () => ({
    rawRms: 0,
    normalizedLevel: 0,
    smoothedLevel: 0,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

const mockVoiceSessionStore = {
  appendDebugEvent: vi.fn(),
  setLastAssistantReply: vi.fn(),
  pendingConfirmation: null,
  setPendingConfirmation: vi.fn(),
};

vi.mock("@/lib/voice/voice-session-store", () => ({
  useVoiceSession: (selector: (store: typeof mockVoiceSessionStore) => unknown) =>
    selector(mockVoiceSessionStore),
}));

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceTurnId: () => "vturn_test",
}));

vi.mock("@/lib/voice/voice-ui-state-machine", () => ({
  canTransitionVoiceUiState: () => true,
  getAllowedVoiceUiTransitions: () => [],
}));

vi.mock("@/lib/voice/voice-tts-playback", () => ({
  VoiceTtsPlaybackManager: class {
    stop() {}
  },
}));

const acquireMock = vi.fn().mockResolvedValue(undefined);
const releaseMock = vi.fn().mockResolvedValue(undefined);
const setMutedMock = vi.fn();
const connectedMock = vi.fn(() => true);
const getSnapshotMock = vi.fn(() => ({
  state: "connected",
  muted: true,
  sessionId: null,
  model: null,
  voice: null,
  reconnectLatencyMs: null,
  lastError: null,
}));
let sessionListener: ((event: unknown) => void) | null = null;
const subscribeMock = vi.fn((listener: (event: unknown) => void) => {
  sessionListener = listener;
  listener({
    type: "connection",
    snapshot: {
      state: "idle",
      muted: true,
      sessionId: null,
      model: null,
      voice: null,
      reconnectLatencyMs: null,
      lastError: null,
    },
    reason: "subscribe",
  });
  return () => {};
});

vi.mock("@/lib/voice/voice-session-manager", () => ({
  voiceSessionManager: {
    acquire: (...args: unknown[]) => acquireMock(...args),
    release: (...args: unknown[]) => releaseMock(...args),
    subscribe: (...args: unknown[]) => subscribeMock(...args),
    connected: (...args: unknown[]) => connectedMock(...args),
    getSnapshot: (...args: unknown[]) => getSnapshotMock(...args),
    isMuted: () => true,
    setMuted: (...args: unknown[]) => setMutedMock(...args),
    toggleMuted: vi.fn(() => true),
    getStream: vi.fn(() => null),
    cancelSpeech: vi.fn(),
    requestSpeech: vi.fn(),
    commitInputAudio: vi.fn(),
    hasActiveScope: vi.fn(() => true),
  },
}));

vi.mock("@/lib/voice/voice-feature-flags", () => ({
  getVoiceV2Flags: () => ({
    enabled: true,
    submitDebugVisible: false,
    ttsBackendFallbackEnabled: false,
    clientVadFallbackEnabled: true,
    autoturnEnabled: true,
  }),
}));

vi.mock("@/lib/voice/voice-turn-orchestrator", () => ({
  VoiceTurnOrchestrator: class {
    updateConfig() {}

    cancelActiveTurn() {}

    processTranscript = vi.fn();
  },
}));

const {
  KaiSearchBar,
  clearClientVadFallbackTimer,
  runAutoTurnDispatchSafely,
  scheduleClientVadFallbackCommit,
  shouldShowAmbientListeningStatus,
  shouldTriggerVoiceBargeIn,
} = await import("@/components/kai/kai-search-bar");

describe("kai-search-bar helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    acquireMock.mockClear();
    releaseMock.mockClear();
    setMutedMock.mockClear();
    connectedMock.mockReset();
    connectedMock.mockReturnValue(true);
    getSnapshotMock.mockReset();
    getSnapshotMock.mockReturnValue({
      state: "connected",
      muted: true,
      sessionId: null,
      model: null,
      voice: null,
      reconnectLatencyMs: null,
      lastError: null,
    });
    sessionListener = null;
    mockVoiceSessionStore.appendDebugEvent.mockClear();
    mockVoiceSessionStore.setLastAssistantReply.mockClear();
    mockVoiceSessionStore.setPendingConfirmation.mockClear();
    Object.defineProperty(global.navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "granted" }),
      },
    });
  });

  afterEach(() => {
    try {
      vi.runOnlyPendingTimers();
    } catch {
      // ignore when a test switches back to real timers
    }
    vi.useRealTimers();
  });

  it("clears the active client VAD fallback timer", () => {
    const commitInputAudio = vi.fn();
    const timerRef = {
      current: window.setTimeout(commitInputAudio, 1200),
    };

    clearClientVadFallbackTimer(timerRef);
    vi.advanceTimersByTime(1500);

    expect(timerRef.current).toBeNull();
    expect(commitInputAudio).not.toHaveBeenCalled();
  });

  it("guards the fallback commit when the session pauses before the timer fires", () => {
    const commitInputAudio = vi.fn();
    const emitDebug = vi.fn();
    const timerRef = { current: null as number | null };
    const sessionMutedRef = { current: false };
    const voiceUiStateRef = { current: "sheet_listening" as const };

    scheduleClientVadFallbackCommit({
      timerRef,
      sessionMutedRef,
      voiceUiStateRef,
      commitInputAudio,
      emitDebug,
      getCurrentTurnId: () => "turn_1",
    });

    sessionMutedRef.current = true;
    voiceUiStateRef.current = "sheet_muted";
    vi.advanceTimersByTime(1200);

    expect(commitInputAudio).not.toHaveBeenCalled();
    expect(emitDebug).not.toHaveBeenCalled();
  });

  it("catches auto-turn dispatch failures and routes them into recovery", async () => {
    vi.useRealTimers();
    const recover = vi.fn();

    runAutoTurnDispatchSafely({
      dispatch: () => Promise.reject(new Error("autoturn_failed")),
      onError: recover,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recover).toHaveBeenCalledWith(expect.any(Error));
    expect(recover.mock.calls[0]?.[0]?.message).toBe("autoturn_failed");
  });

  it("only treats meaningful partial transcripts as a barge-in signal", () => {
    expect(shouldTriggerVoiceBargeIn("uh")).toBe(false);
    expect(shouldTriggerVoiceBargeIn("hm")).toBe(false);
    expect(shouldTriggerVoiceBargeIn("stop")).toBe(true);
    expect(shouldTriggerVoiceBargeIn("open profile")).toBe(true);
    expect(shouldTriggerVoiceBargeIn("NVDA today")).toBe(true);
  });

  it("does not overwrite a real transcript with ambient listening copy", () => {
    expect(shouldShowAmbientListeningStatus("Listening...")).toBe(true);
    expect(shouldShowAmbientListeningStatus("Audio detected...")).toBe(true);
    expect(shouldShowAmbientListeningStatus("Analyze Nvidia")).toBe(false);
  });

  it("does not acquire a realtime session on mount", () => {
    vi.useRealTimers();
    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("acquires on explicit mic tap and releases on cancel", async () => {
    vi.useRealTimers();
    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    await waitFor(() => {
      expect(acquireMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_1",
          vaultOwnerToken: "vault_token",
          activate: true,
        })
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("voice-console-sheet")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("cancel voice"));

    await waitFor(() => {
      expect(releaseMock).toHaveBeenCalled();
    });
  });

  it("does not surface retry UI when voice connect is cancelled", async () => {
    vi.useRealTimers();
    acquireMock.mockRejectedValueOnce(new Error("VOICE_SESSION_CONNECT_ABORTED"));

    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    await waitFor(() => {
      expect(acquireMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("voice-compact-status")).toBeNull();
      expect(screen.queryByText("Connection failed. Tap retry to try again.")).toBeNull();
    });
  });

  it("shows the voice sheet immediately while the session is still connecting", async () => {
    vi.useRealTimers();
    Object.defineProperty(global.navigator, "permissions", {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: "prompt" }),
      },
    });
    acquireMock.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          // keep pending to simulate a slow live connect
        })
    );

    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    await waitFor(() => {
      const sheet = screen.getByTestId("voice-console-sheet");
      expect(sheet).toBeTruthy();
      expect(sheet.getAttribute("data-muted")).toBe("false");
      expect(screen.getByTestId("voice-console-preview").textContent).toContain(
        "Waiting for microphone access"
      );
    });
  });

  it("shows connect-stage updates while the session is still muted and connecting", async () => {
    vi.useRealTimers();
    acquireMock.mockImplementationOnce(
      () =>
        new Promise<void>(() => {
          // keep pending to simulate a live connect
        })
    );
    connectedMock.mockReturnValue(false);
    getSnapshotMock.mockReturnValue({
      state: "connecting",
      muted: true,
      sessionId: null,
      model: null,
      voice: null,
      reconnectLatencyMs: null,
      lastError: null,
    });

    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    await waitFor(() => {
      expect(screen.getByTestId("voice-console-sheet")).toBeTruthy();
    });

    await act(async () => {
      sessionListener?.({
        type: "debug",
        event: "realtime_handshake_started",
        payload: {},
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("voice-console-preview").textContent).toContain(
        "Opening realtime voice connection"
      );
    });
  });

  it("unmutes an existing realtime session without reacquiring it", async () => {
    vi.useRealTimers();
    connectedMock.mockReturnValue(true);
    getSnapshotMock.mockReturnValue({
      state: "connected",
      muted: true,
      sessionId: "sess_1",
      model: "gpt-realtime",
      voice: "alloy",
      reconnectLatencyMs: 420,
      lastError: null,
    });

    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    await act(async () => {
      sessionListener?.({
        type: "connection",
        snapshot: {
          state: "connected",
          muted: true,
          sessionId: "sess_1",
          model: "gpt-realtime",
          voice: "alloy",
          reconnectLatencyMs: 420,
          lastError: null,
        },
        reason: "manual_restore",
      });
    });

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    await waitFor(() => {
      expect(setMutedMock).toHaveBeenCalledWith(false);
      expect(acquireMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("voice-console-preview").textContent).toContain("Listening");
    });
  });

  it("treats an acquire race that ends back at idle as a cancellation instead of a failure", async () => {
    vi.useRealTimers();
    connectedMock.mockReturnValue(false);
    getSnapshotMock.mockReturnValue({
      state: "idle",
      muted: true,
      sessionId: null,
      model: null,
      voice: null,
      reconnectLatencyMs: null,
      lastError: null,
    });

    render(
      createElement(KaiSearchBar, {
        onCommand: vi.fn(),
        onVoiceResponse: vi.fn(),
        userId: "user_1",
        vaultOwnerToken: "vault_token",
      })
    );

    fireEvent.click(screen.getByLabelText("Toggle voice microphone"));

    await waitFor(() => {
      expect(acquireMock).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("voice-compact-status")).toBeNull();
      expect(screen.queryByText("Connection failed. Tap retry to try again.")).toBeNull();
    });
  });
});

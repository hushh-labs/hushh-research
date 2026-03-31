import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  VoiceCompactStatus: () => null,
}));

vi.mock("@/components/kai/voice/voice-console-sheet", () => ({
  VoiceConsoleSheet: () => null,
}));

vi.mock("@/components/kai/voice/voice-debug-drawer", () => ({
  VoiceDebugDrawer: () => null,
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: () => null,
}));

vi.mock("@/lib/morphy-ux/morphy", () => ({
  morphyToast: {
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/morphy-ux/ui", () => ({
  Icon: () => null,
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

vi.mock("@/lib/voice/use-amplitude-meter", () => ({
  useAmplitudeMeter: () => ({
    rawRms: 0,
    normalizedLevel: 0,
    smoothedLevel: 0,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("@/lib/voice/voice-session-store", () => ({
  useVoiceSession: () => vi.fn(),
}));

vi.mock("@/lib/voice/voice-telemetry", () => ({
  createVoiceTurnId: () => "vturn_test",
}));

vi.mock("@/lib/voice/voice-ui-state-machine", () => ({
  canTransitionVoiceUiState: () => true,
  getAllowedVoiceUiTransitions: () => [],
}));

vi.mock("@/lib/voice/voice-tts-playback", () => ({
  VoiceTtsPlaybackManager: class {},
}));

vi.mock("@/lib/voice/voice-session-manager", () => ({
  voiceSessionManager: {
    commitInputAudio: vi.fn(),
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
  VoiceTurnOrchestrator: class {},
}));

const {
  clearClientVadFallbackTimer,
  runAutoTurnDispatchSafely,
  scheduleClientVadFallbackCommit,
} = await import("@/components/kai/kai-search-bar");

describe("kai-search-bar helpers", () => {

  beforeEach(() => {
    vi.useFakeTimers();
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
    voiceUiStateRef.current = "sheet_paused";
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
});

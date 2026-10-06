import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_CONVERSATION_OUTCOME_EVENT,
  cancelAgentConversationRequest,
  isAgentConversationOwnerReady,
  requestAgentConversation,
  requestAgentConversationStop,
  resetAgentConversationBrokerForTests,
  type AgentConversationOutcome,
} from "@/lib/agent/agent-voice-settings";
import { updateVoicePreferences } from "@/lib/agent/voice-preferences";
import { forgetSpeakerphoneSafePreference, writeSpeakerphoneSafePreference } from "@/lib/one-voice/speakerphone-preferences";
import type {
  CaptureStartOptions,
  CaptureStartResult,
} from "@/lib/one-voice/audio/capture";
import type {
  AppContextInput,
  LiveCloseInfo,
  OneLiveClientOptions,
} from "@/lib/one-voice/live-client";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import type { VoiceSessionController } from "@/lib/one-voice/session-types";

import { pendingActionFrame, readyFrame } from "../../../__tests__/one-voice/fixtures/scripted-server";

const harness = vi.hoisted(() => ({
  vault: { isVaultUnlocked: true, vaultOwnerToken: "vault-owner-token" },
  user: { uid: "owner-1" } as { uid: string } | null,
  leases: [] as Array<{
    owner: string;
    onRevoked: (reason: string) => void;
    released: string[];
  }>,
  pathname: "/one/location",
  platform: "web",
  lifecycle: "active" as "active" | "background",
  lifecycleListeners: new Set<() => void>(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname }));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: harness.user }),
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => harness.vault }));
vi.mock("@/lib/agent/agent-runtime-context", () => ({
  useAgentRuntimeStateOptional: () => null,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => harness.platform },
}));
vi.mock("@capacitor/app", () => ({ App: {} }));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getFirebaseIdToken: vi.fn(async () => "firebase-proof") },
  normalizeNativeBackendUrl: (value: string) => value,
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  getVoiceSurfaceMetadata: () => null,
}));
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: ({ open, title }: { open: boolean; title: string }) =>
    open ? <div role="dialog">{title}</div> : null,
}));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    getLifecycleSnapshot: () => ({ state: harness.lifecycle }),
    subscribeLifecycle: (listener: () => void) => {
      harness.lifecycleListeners.add(listener);
      return () => harness.lifecycleListeners.delete(listener);
    },
    acquireVoiceLease: ({
      owner,
      onRevoked,
    }: {
      owner: string;
      onRevoked: (reason: string) => void;
    }) => {
      const record = { owner, onRevoked, released: [] as string[] };
      harness.leases.push(record);
      return {
        id: `lease-${harness.leases.length}`,
        owner,
        isCurrent: () => true,
        release: (reason = "released") => {
          record.released.push(reason);
        },
      };
    },
  },
}));

function publishLifecycle(state: "active" | "background") {
  if (harness.lifecycle === state) return;
  harness.lifecycle = state;
  for (const listener of harness.lifecycleListeners) listener();
  if (state === "background") {
    const active = [...harness.leases]
      .reverse()
      .find((lease) => lease.released.length === 0);
    active?.onRevoked("app_backgrounded");
  }
}

import {
  VoiceSessionProvider,
  type VoiceSessionDeps,
  useVoiceSession,
} from "@/components/one-voice/voice-session-provider";
import { OneVoicePanel } from "@/components/one-voice/one-voice-panel";

/** A client fake that answers connect() with session.ready and reports close. */
class FakeClient {
  static instances: FakeClient[] = [];
  readonly options: OneLiveClientOptions;
  readonly sent: string[] = [];
  readonly audioFrames: Uint8Array[] = [];
  readonly perf: Array<{ metric: string; durationMs: number; turnId?: string }> = [];
  /** Each app_context payload, in order; each one replaces the relay's screen context. */
  readonly appContexts: AppContextInput[] = [];
  readonly mailDeliveries: Array<[deliveryRef: string, actionId: string]> = [];
  readonly nameEdits: Array<[pendingActionId: string, name: string, operationId: string]> = [];
  closeReasons: string[] = [];
  connected = 0;
  isReady = false;
  constructor(options: OneLiveClientOptions) {
    this.options = options;
    FakeClient.instances.push(this);
  }
  async connect() {
    this.connected += 1;
    const auth = this.options.auth();
    if (!auth) throw new Error("auth missing");
    await this.options.ticket();
    this.isReady = true;
    this.options.onFrame(readyFrame({ conversation_id: auth.conversationId }));
  }
  close(reason = "ended") {
    if (!this.isReady && this.closeReasons.length > 0) return;
    this.closeReasons.push(reason);
    this.isReady = false;
    const info: LiveCloseInfo = {
      code: 1000,
      reason,
      clean: true,
      resumable: false,
    };
    this.options.onClose(info);
  }
  sendAudio(pcm16: Uint8Array) {
    this.audioFrames.push(pcm16);
    return this.isReady;
  }
  sendPerf(metric: string, durationMs: number, turnId?: string) {
    this.perf.push({ metric, durationMs, ...(turnId ? { turnId } : {}) });
    return this.isReady;
  }
  sendText(text: string) {
    this.sent.push(`text:${text}`);
    return true;
  }
  sendAppContext(context: AppContextInput) {
    this.sent.push("app_context");
    this.appContexts.push(context);
  }
  mailDeliveryResult(deliveryRef: string, actionId: string) {
    this.mailDeliveries.push([deliveryRef, actionId]);
    return true;
  }
  nameEditSubmit(pendingActionId: string, name: string, operationId: string) {
    this.nameEdits.push([pendingActionId, name, operationId]);
    return true;
  }
  pendingShown(pendingActionId: string) {
    this.sent.push(`pending_shown:${pendingActionId}`);
    return true;
  }
  confirm() {
    return true;
  }
  cancel(options: { scope: string }) {
    this.sent.push(`cancel:${options.scope}`);
    return true;
  }
  chooseCandidate() {
    return true;
  }
  clientStepResult(stepId: string, status: string) {
    this.sent.push(`client_step:${stepId}:${status}`);
    return true;
  }
  uiSettled(directiveId: string, status: string) {
    this.sent.push(`ui_settled:${directiveId}:${status}`);
    return true;
  }
  interrupt() {
    return true;
  }
}

class FakeCapture {
  started = 0;
  stopped = 0;
  options: CaptureStartOptions | null = null;
  isTrackLive?: () => boolean;
  async start(options: CaptureStartOptions): Promise<CaptureStartResult> {
    this.started += 1;
    this.options = options;
    return { sampleRate: 48_000, echoCancellation: true };
  }
  setMuted() {}
  stop() {
    this.stopped += 1;
  }
}

let playbackStarted: ((turnId: string) => void) | null = null;
let speakingChanged: ((speaking: boolean) => void) | null = null;
const playback = {
  speaking: false,
  enqueue: () => true,
  flush: () => undefined,
  fenceTurn: () => undefined,
  onSpeakingChanged: (callback: (speaking: boolean) => void) => {
    speakingChanged = callback;
    return () => { speakingChanged = null; };
  },
  onPlaybackStarted: (callback: (turnId: string) => void) => {
    playbackStarted = callback;
    return () => { playbackStarted = null; };
  },
  close: () => undefined,
};

function setPlaybackSpeaking(speaking: boolean) {
  playback.speaking = speaking;
  speakingChanged?.(speaking);
}

let controller: VoiceSessionController | null = null;
function Probe() {
  const session = useVoiceSession();
  useEffect(() => {
    controller = session;
  });
  return <output data-testid="phase">{session.state.phase}</output>;
}

function PendingPanelProbe() {
  const session = useVoiceSession();
  return session.state.pendingAction?.resolvedStatus === null
    ? <OneVoicePanel state={session.state} controller={session} />
    : null;
}

function mockVisiblePendingGeometry(offscreenUntilScrolled = false) {
  const rect = (top: number, bottom: number) => ({
    x: 0, y: top, left: 0, top, right: 320, bottom,
    width: 320, height: bottom - top, toJSON: () => ({}),
  }) as DOMRect;
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-testid="one-voice-panel"]')) return rect(50, 450);
    if (this.matches("[data-pending-action-id]")) {
      const panel = this.closest<HTMLElement>('[data-testid="one-voice-panel"]');
      const top = offscreenUntilScrolled && !panel?.scrollTop ? 500 : 100;
      return rect(top, top + 160);
    }
    return rect(0, 0);
  });
}

function mount(enabled = true, children?: ReactNode, overrides: Partial<VoiceSessionDeps> = {}) {
  const capture = new FakeCapture();
  const deps = {
    createClient: (options: OneLiveClientOptions) => new FakeClient(options),
    createCapture: () => capture,
    createPlayback: () => playback,
    createAudioContext: () => null,
    mintTicket: async () => ({
      ticket: "ticket",
      wsPath: "/api/one/voice/live",
    }),
    afterPaint: (callback: () => void) => callback(),
    ...overrides,
  };
  const view = render(
    <VoiceSessionProvider enabled={enabled} deps={deps}>
      <Probe />
      {children}
    </VoiceSessionProvider>,
  );
  return { capture, deps, rerender: view.rerender };
}

function outcomes(): AgentConversationOutcome[] {
  const received: AgentConversationOutcome[] = [];
  window.addEventListener(AGENT_CONVERSATION_OUTCOME_EVENT, (event) => {
    received.push((event as CustomEvent<AgentConversationOutcome>).detail);
  });
  return received;
}

beforeEach(() => {
  resetAgentConversationBrokerForTests();
  useVoiceSessionStore.getState().reset();
  FakeClient.instances = [];
  playbackStarted = null;
  speakingChanged = null;
  playback.speaking = false;
  harness.leases = [];
  harness.pathname = "/one/location";
  harness.platform = "web";
  forgetSpeakerphoneSafePreference("owner-1");
  harness.lifecycle = "active";
  harness.lifecycleListeners.clear();
  harness.vault = {
    isVaultUnlocked: true,
    vaultOwnerToken: "vault-owner-token",
  };
  harness.user = { uid: "owner-1" };
  updateVoicePreferences("owner-1", (current) => ({
    ...current,
    voiceEnabled: true,
  }));
});

afterEach(() => {
  cleanup();
  controller = null;
  vi.restoreAllMocks();
});

describe("VoiceSessionProvider ownership", () => {
  it.each(["ios-default", "owner-preference", "late-microphone"] as const)(
    "drops speaker echo and its tail when protection is selected by %s",
    async (mode) => {
      if (mode === "ios-default") harness.platform = "ios";
      if (mode === "owner-preference") writeSpeakerphoneSafePreference("owner-1", true);
      const { capture, deps, rerender } = mount();
      let speaking!: (value: boolean) => void;
      let ready!: () => void;
      let at = 10_000;
      deps.now = () => at;
      deps.createPlayback = () => ({ ...playback, onSpeakingChanged: callback => {
        speaking = callback;
        return () => undefined;
      } });
      if (mode === "late-microphone") capture.start = async options => {
        capture.options = options;
        capture.started++;
        await new Promise<void>(resolve => { ready = resolve; });
        return { sampleRate: 48_000, echoCancellation: false };
      };
      rerender(<VoiceSessionProvider enabled deps={deps}><Probe /></VoiceSessionProvider>);
      let starting!: Promise<void>;
      await act(async () => { starting = controller!.start(); });
      await waitFor(() => expect(capture.started).toBe(1));
      if (mode === "late-microphone") {
        act(() => speaking(true));
        await act(async () => { ready(); await starting; });
      } else {
        await act(async () => starting);
        act(() => speaking(true));
      }
      expect(controller!.state.halfDuplex).toBe(true);
      const send = vi.spyOn(FakeClient.instances[0]!, "sendAudio");
      capture.options!.onFrame(new Uint8Array(640));
      expect(send).not.toHaveBeenCalled();
      act(() => speaking(false));
      capture.options!.onFrame(new Uint8Array(640));
      expect(send).not.toHaveBeenCalled();
      at += 250;
      capture.options!.onFrame(new Uint8Array(640));
      expect(send).toHaveBeenCalledOnce();
    },
  );
  it("Stop settles during lazy client loading and retires its late resources without closing a newer session", async () => {
    const { deps, rerender } = mount();
    let resolveClient!: (value: FakeClient) => void;
    let oldOptions!: OneLiveClientOptions;
    const retiredPlayback = { ...playback, close: vi.fn(), flush: vi.fn() };
    deps.createPlayback = () => retiredPlayback;
    deps.createClient = (options) => {
      oldOptions = options;
      return new Promise<FakeClient>(resolve => { resolveClient = resolve; });
    };
    rerender(<VoiceSessionProvider enabled deps={deps}><Probe /></VoiceSessionProvider>);
    let pending!: Promise<void>;
    await act(async () => { pending = controller!.start(); });
    expect(controller!.state.phase).toBe("connecting");
    act(() => controller!.stop());
    expect(controller!.state.phase).toBe("idle");
    deps.createClient = options => new FakeClient(options);
    deps.createPlayback = () => playback;
    await act(async () => { await controller!.start(); });
    const current = FakeClient.instances[0]!;
    await act(async () => { resolveClient(new FakeClient(oldOptions)); await pending; });
    expect(retiredPlayback.close).toHaveBeenCalledOnce();
    expect(FakeClient.instances[1]!.connected).toBe(0);
    expect(FakeClient.instances[1]!.closeReasons).toEqual(["local:cancelled"]);
    expect(current.closeReasons).toEqual([]);
    expect(controller!.state.phase).toBe("listening");
  });
  it("announces itself owner-ready only while enabled", () => {
    const { rerender } = mount(false);
    expect(isAgentConversationOwnerReady()).toBe(false);
    rerender(
      <VoiceSessionProvider
        enabled
        deps={{ createClient: (options) => new FakeClient(options) }}
      >
        <Probe />
      </VoiceSessionProvider>,
    );
    expect(isAgentConversationOwnerReady()).toBe(true);
  });

  it("a conversation request starts a session and is acknowledged accepted", async () => {
    const received = outcomes();
    const { capture } = mount();
    await act(async () => {
      expect(
        requestAgentConversation({ source: "agent_chat", requestId: "req-1" }),
      ).toBe("dispatched");
    });
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("listening"),
    );
    expect(FakeClient.instances).toHaveLength(1);
    expect(capture.started).toBe(1);
    await waitFor(() =>
      expect(received).toEqual([
        { source: "agent_chat", requestId: "req-1", outcome: "accepted" },
      ]),
    );
    expect(harness.leases).toHaveLength(1);
    expect(harness.leases[0]?.owner).toBe("one-voice-live");
  });

  it("does not show Listening or revive capture when Stop wins a pending microphone start", async () => {
    const { deps, rerender } = mount();
    const capture = new FakeCapture();
    let finishCapture!: () => void;
    capture.start = async (options) => {
      capture.started += 1;
      capture.options = options;
      await new Promise<void>((resolve) => {
        finishCapture = resolve;
      });
      return { sampleRate: 48_000, echoCancellation: true };
    };
    deps.createCapture = () => capture;
    rerender(
      <VoiceSessionProvider enabled deps={deps}>
        <Probe />
      </VoiceSessionProvider>,
    );
    let starting!: Promise<void>;
    await act(async () => {
      starting = controller!.start();
      await Promise.resolve();
    });
    await waitFor(() => expect(capture.started).toBe(1));
    expect(controller!.state.phase).toBe("paused");

    await act(async () => controller!.stop("tap"));
    await act(async () => {
      finishCapture();
      await starting;
    });

    expect(controller!.state.phase).toBe("idle");
    expect(capture.stopped).toBeGreaterThan(0);
    expect(FakeClient.instances).toHaveLength(1);
    expect(FakeClient.instances[0]!.closeReasons).toEqual(["local:tap"]);
  });

  it("a request queued before the owner mounts is delivered once it announces", async () => {
    expect(requestAgentConversation({ requestId: "early" })).toBe("queued");
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("listening"),
    );
  });

  it("a native handoff with text is typed into the live session, never spoken by the app", async () => {
    const received = outcomes();
    mount();
    await act(async () => {
      requestAgentConversation({
        source: "siri_app_shortcut",
        requestId: "siri-1",
        initialRequestText: "share my location with Priya",
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("listening"),
    );
    await waitFor(() =>
      expect(FakeClient.instances[0]?.sent).toContain(
        "text:share my location with Priya",
      ),
    );
    await waitFor(() => expect(received[0]?.outcome).toBe("accepted"));
  });

  it("does not suppress later audio forever when a typed input echo is lost", async () => {
    const enqueue = vi.spyOn(playback, "enqueue");
    const at = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(at);
    mount();
    await act(async () => {
      await controller!.start();
    });
    const client = FakeClient.instances[0]!;
    await act(async () => controller!.sendText("What is my name?"));
    const audio = {
      type: "audio" as const,
      data: "AAAA",
      mime_type: "audio/pcm;rate=24000",
      turn_id: "later-turn",
    };
    await act(async () => client.options.onFrame(audio));
    expect(enqueue).not.toHaveBeenCalled();

    clock.mockReturnValue(at + 10_001);
    await act(async () => client.options.onFrame(audio));
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("reports client endpointing and first observed playback onset without content", async () => {
    const clock = { now: 1000 };
    const { capture } = mount(true, undefined, { perfNow: () => clock.now });
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const level = capture.options!.onLevel!;
    level(0.2); // Speech is observed.
    for (clock.now = 1100; clock.now <= 1400; clock.now += 100)
      level(0.01); // Quiet candidate starts at 1100 after a 300 ms hold.
    clock.now = 1800;
    await act(async () => client.options.onFrame({
      type: "transcript.input", turn_id: "abcdef012345", text: "private words", final: true,
    }));
    expect(client.perf).toEqual([{
      metric: "endpointing_client", durationMs: 700, turnId: "abcdef012345",
    }]);

    clock.now = 2000;
    await act(async () => client.options.onFrame({
      type: "audio", turn_id: "012345abcdef", origin_turn_id: "abcdef012345",
      data: "AAAA", mime_type: "audio/pcm;rate=24000",
    }));
    expect(client.perf).toHaveLength(1); // enqueue is not output onset.
    clock.now = 2120;
    await act(async () => playbackStarted?.("012345abcdef"));
    expect(client.perf).toEqual([
      { metric: "endpointing_client", durationMs: 700, turnId: "abcdef012345" },
      { metric: "audio_receive_to_audible", durationMs: 120, turnId: "012345abcdef" },
    ]);
    expect(JSON.stringify(client.perf)).not.toContain("private words");
  });

  it.each([
    ["playback rejects the narration", "AAAA", true],
    ["the narration has malformed base64", "%%%", false],
  ])("keeps the mic open when %s", async (_case, data, rejectPlayback) => {
    const { capture } = mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const micFrame = new Uint8Array([1, 2]);
    const enqueue = vi.spyOn(playback, "enqueue");
    if (rejectPlayback) enqueue.mockReturnValue(false);

    await act(async () => client.options.onFrame({
      type: "audio", turn_id: "narration-failed", narration: true,
      data, mime_type: "audio/pcm;rate=24000",
    }));
    expect(enqueue).toHaveBeenCalledTimes(rejectPlayback ? 1 : 0);
    capture.options!.onFrame(micFrame);
    expect(client.audioFrames).toEqual([micFrame]);
  });

  it("keeps the mic closed after a failed late narration chunk until earlier speech drains", async () => {
    const { capture } = mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const micFrame = new Uint8Array([3, 4]);

    await act(async () => client.options.onFrame({
      type: "audio", turn_id: "narration-first", narration: true,
      data: "AAAA", mime_type: "audio/pcm;rate=24000",
    }));
    await act(async () => setPlaybackSpeaking(true));
    const enqueue = vi.spyOn(playback, "enqueue").mockReturnValue(false);
    await act(async () => client.options.onFrame({
      type: "audio", turn_id: "narration-late", narration: true,
      data: "AAAA", mime_type: "audio/pcm;rate=24000",
    }));
    expect(enqueue).toHaveBeenCalledOnce();
    capture.options!.onFrame(micFrame);
    expect(client.audioFrames).toHaveLength(0);

    await act(async () => setPlaybackSpeaking(false));
    capture.options!.onFrame(micFrame);
    expect(client.audioFrames).toEqual([micFrame]);
  });

  it("does not mute barge-in when narration fails during ordinary playback", async () => {
    const { capture } = mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const micFrame = new Uint8Array([5, 6]);

    await act(async () => client.options.onFrame({
      type: "audio", turn_id: "ordinary-speech",
      data: "AAAA", mime_type: "audio/pcm;rate=24000",
    }));
    await act(async () => setPlaybackSpeaking(true));
    vi.spyOn(playback, "enqueue").mockReturnValue(false);
    await act(async () => client.options.onFrame({
      type: "audio", turn_id: "narration-failed", narration: true,
      data: "AAAA", mime_type: "audio/pcm;rate=24000",
    }));

    capture.options!.onFrame(micFrame);
    expect(client.audioFrames).toEqual([micFrame]);
  });

  it("stops old speech on a new voice input before a provider interrupt arrives", async () => {
    const enqueue = vi.spyOn(playback, "enqueue");
    const flush = vi.spyOn(playback, "flush");
    const fence = vi.spyOn(playback, "fenceTurn");
    mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    await act(async () => {
      client.options.onFrame({ type: "transcript.input", turn_id: "a", text: "First", final: true });
      client.options.onFrame({ type: "audio", turn_id: "a", origin_turn_id: "a", data: "AAAA", mime_type: "audio/pcm;rate=24000" });
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    flush.mockClear();
    fence.mockClear();

    await act(async () => {
      client.options.onFrame({ type: "transcript.input", turn_id: "b", text: "Second", final: true });
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(fence).toHaveBeenCalledWith("a");
    await act(async () => {
      client.options.onFrame({ type: "audio", turn_id: "a", origin_turn_id: "a", data: "AAAA", mime_type: "audio/pcm;rate=24000" });
      client.options.onFrame({ type: "audio", turn_id: "b", origin_turn_id: "b", data: "AAAA", mime_type: "audio/pcm;rate=24000" });
    });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge a pending action when its card is absent", async () => {
    mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const pending = pendingActionFrame();

    await act(async () => client.options.onFrame(pending));
    expect(controller!.state.pendingAction?.pending_action_id).toBe(pending.pending_action_id);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(client.sent).not.toContain(`pending_shown:${pending.pending_action_id}`);
  });

  it("acknowledges the exact pending card after React mounts it on screen", async () => {
    mockVisiblePendingGeometry();
    const { deps } = mount(true, <PendingPanelProbe />);
    // Control paint explicitly: async act can itself cross a real rAF on a
    // busy host, making an assertion before that rAF nondeterministic.
    let paint!: () => void;
    deps.afterPaint = callback => { paint = callback; };
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const pending = pendingActionFrame();

    await act(async () => client.options.onFrame(pending));
    expect(screen.getByTestId("one-voice-pending-action").getAttribute("data-pending-action-id"))
      .toBe(pending.pending_action_id);
    expect(client.sent).not.toContain(`pending_shown:${pending.pending_action_id}`);
    act(() => paint());
    await waitFor(() =>
      expect(client.sent).toContain(`pending_shown:${pending.pending_action_id}`),
    );
    expect(client.sent.filter((sent) => sent === `pending_shown:${pending.pending_action_id}`))
      .toHaveLength(1);
  });

  it("scrolls a pending card below a long panel into view before acknowledging it", async () => {
    mockVisiblePendingGeometry(true);
    mount(true, <PendingPanelProbe />);
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const pending = pendingActionFrame();

    await act(async () => client.options.onFrame(pending));
    const panel = screen.getByTestId("one-voice-panel");
    expect(client.sent).not.toContain(`pending_shown:${pending.pending_action_id}`);
    await waitFor(() => expect(panel.scrollTop).toBeGreaterThan(0));
    await waitFor(() =>
      expect(client.sent).toContain(`pending_shown:${pending.pending_action_id}`),
    );
  });

  it("does not acknowledge a mounted pending card hidden by its panel ancestor", async () => {
    mockVisiblePendingGeometry();
    mount(true, <div style={{ visibility: "hidden" }}><PendingPanelProbe /></div>);
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const pending = pendingActionFrame();

    await act(async () => client.options.onFrame(pending));
    expect(screen.getByTestId("one-voice-pending-action")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(client.sent).not.toContain(`pending_shown:${pending.pending_action_id}`);
  });

  it("does not deliver a superseded Mail result or directive to screen handlers", async () => {
    const onToolResult = vi.fn();
    const onDirective = vi.fn();
    const onClientStep = vi.fn();
    const key = Symbol("screen-effects");
    useVoiceSessionStore.getState().effects.set(key, { onToolResult, onDirective, onClientStep });
    try {
      mount();
      await act(async () => controller!.start());
      const client = FakeClient.instances[0]!;
      await act(async () => {
        client.options.onFrame({ type: "transcript.input", turn_id: "mail-a", text: "Read mail", final: true });
        client.options.onFrame({ type: "transcript.input", turn_id: "name-b", text: "My name", final: true });
        client.options.onFrame({
          type: "tool.result", call_id: "mail-call", tool: "read_mail", turn_id: "mail-a",
          status: "ok", ok: true, result_public: { status: "ok", items: [{ source_ref: "mail:1" }] },
        });
        client.options.onFrame({
          type: "ui_directive", directive_id: "old-open", kind: "open_mail",
          payload: { ordinal: 1 }, turn_id: "mail-a",
        });
        client.options.onFrame({
          type: "client_step.request", step_id: "old-step", kind: "open_screen",
          payload: {}, timeout_s: 10, turn_id: "mail-a",
        });
      });
      expect(onToolResult).not.toHaveBeenCalled();
      expect(onDirective).not.toHaveBeenCalled();
      expect(onClientStep).not.toHaveBeenCalled();
      expect(client.sent).toContain("ui_settled:old-open:ignored");
      expect(client.sent).toContain("client_step:old-step:failed");
      expect(controller!.state.lastResult).toBeNull();

      await act(async () => client.options.onFrame({
        type: "tool.result", call_id: "profile-call", tool: "get_profile", turn_id: "name-b",
        status: "ok", ok: true, result_public: { status: "ok", display_name: "Owner" },
      }));
      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(controller!.state.lastResult?.display_name).toBe("Owner");
    } finally {
      useVoiceSessionStore.getState().effects.delete(key);
    }
  });

  it("runs an explicitly confirmed old device step without changing the newer answer", async () => {
    const onClientStep = vi.fn();
    const key = Symbol("confirmed-old-step");
    useVoiceSessionStore.getState().effects.set(key, { onClientStep });
    try {
      mount();
      await act(async () => controller!.start());
      const client = FakeClient.instances[0]!;
      await act(async () => {
        client.options.onFrame({ type: "transcript.input", turn_id: "a", text: "Turn on Location", final: true });
        client.options.onFrame({ type: "transcript.input", turn_id: "b", text: "What is my name?", final: true });
        client.options.onFrame({
          type: "tool.result", call_id: "profile-b", tool: "get_profile", turn_id: "b",
          status: "ok", ok: true, result_public: { status: "ok", display_name: "Owner" },
        });
        client.options.onFrame({ type: "turn", turn_id: "b", state: "model_end" });
        client.options.onFrame({
          type: "client_step.request", step_id: "confirmed-step", kind: "set_location_updates",
          payload: { desired_state: "on" }, timeout_s: 10, turn_id: "a",
          confirmed_pending_action_id: "pending-a",
        });
      });
      expect(onClientStep).toHaveBeenCalledTimes(1);
      expect(onClientStep.mock.calls[0]?.[0]).toMatchObject({ stepId: "confirmed-step" });
      expect(client.sent).not.toContain("client_step:confirmed-step:failed");
      expect(controller!.state.lastResult?.display_name).toBe("Owner");
    } finally {
      useVoiceSessionStore.getState().effects.delete(key);
    }
  });

  it("reports a re-listed card the server never saw shown, once painted", async () => {
    // Regression: a pending_action frame lost to a reconnect left the card
    // unshown on the server, so "yes" was refused and One asked again.
    mockVisiblePendingGeometry();
    mount(true, <PendingPanelProbe />);
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const unshown = pendingActionFrame({ pending_action_id: "card-unshown" });
    await act(async () => {
      client.options.onFrame(
        readyFrame({ pending_actions: [unshown], resumed: true }),
      );
    });
    expect(screen.getByTestId("one-voice-pending-action").getAttribute("data-pending-action-id"))
      .toBe(unshown.pending_action_id);
    expect(client.sent).not.toContain("pending_shown:card-unshown");
    await waitFor(() => expect(client.sent).toContain("pending_shown:card-unshown"));
    await act(async () => {
      client.options.onFrame(
        readyFrame({ pending_actions: [unshown], resumed: true }),
      );
    });
    expect(client.sent.filter((sent) => sent === "pending_shown:card-unshown"))
      .toHaveLength(1);

    // Negative control: a card the server already knows is shown is not re-sent.
    const shown = pendingActionFrame({
      pending_action_id: "card-shown",
      shown_at: "2026-10-02T10:00:00Z",
    });
    await act(async () => {
      client.options.onFrame(
        readyFrame({ pending_actions: [shown], resumed: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(client.sent).not.toContain("pending_shown:card-shown");
  });

  it("does not acknowledge a restored card when its panel is absent", async () => {
    mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const unshown = pendingActionFrame({ pending_action_id: "card-not-mounted" });
    await act(async () => {
      client.options.onFrame(
        readyFrame({ pending_actions: [unshown], resumed: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(client.sent).not.toContain("pending_shown:card-not-mounted");
  });

  it("keeps an older restored card from taking over after the next answer ends", async () => {
    const onToolResult = vi.fn();
    const key = Symbol("restored-card-effects");
    useVoiceSessionStore.getState().effects.set(key, { onToolResult });
    try {
      mount();
      await act(async () => controller!.start());
      const client = FakeClient.instances[0]!;
      const card = pendingActionFrame({ origin_turn_id: "before-reconnect" });
      await act(async () => {
        client.options.onFrame(readyFrame({ pending_actions: [card], resumed: true }));
        client.options.onFrame({ type: "transcript.input", turn_id: "after-reconnect", text: "New question", final: true });
        client.options.onFrame({ type: "turn", turn_id: "after-reconnect", state: "model_end" });
        client.options.onFrame({
          type: "tool.result", call_id: null, pending_action_id: card.pending_action_id,
          tool: "delete_thing", turn_id: "before-reconnect", status: "deleted", ok: true,
          result_public: { status: "deleted" },
        });
        client.options.onFrame({
          type: "tool.result", call_id: null, tool: "read_mail", status: "ok", ok: true,
          result_public: { status: "ok", items: [{ source_ref: "mail:1" }] },
        });
      });
      expect(onToolResult).not.toHaveBeenCalled();
      expect(controller!.state.lastResult).toBeNull();
    } finally {
      useVoiceSessionStore.getState().effects.delete(key);
    }
  });

  it("settles an in-flight directive as ignored when a newer question arrives", async () => {
    let finishDirective: ((status: "opened" | "failed" | "ignored") => void) | null = null;
    const key = Symbol("delayed-directive");
    useVoiceSessionStore.getState().effects.set(key, {
      onDirective: (_id, _kind, _payload, settle) => { finishDirective = settle; },
    });
    try {
      mount();
      await act(async () => controller!.start());
      const client = FakeClient.instances[0]!;
      await act(async () => {
        client.options.onFrame({ type: "transcript.input", turn_id: "a", text: "Open mail", final: true });
        client.options.onFrame({
          type: "ui_directive", directive_id: "a-open", kind: "navigate",
          payload: { gateway_action_id: "route.one_location" }, turn_id: "a",
        });
      });
      await waitFor(() => expect(finishDirective).not.toBeNull());
      await act(async () => client.options.onFrame({
        type: "transcript.input", turn_id: "b", text: "My name", final: true,
      }));
      await act(async () => finishDirective?.("opened"));
      expect(client.sent).toContain("ui_settled:a-open:ignored");
    } finally {
      useVoiceSessionStore.getState().effects.delete(key);
    }
  });

  it("the auth frame carries a freshly fetched sign-in proof, so a spoken yes can be verified", async () => {
    mount();
    await act(async () => {
      await controller!.start();
    });
    const client = FakeClient.instances[0]!;
    // The real client mints the ticket (which fetches the proof) before it
    // opens the socket and reads auth(); mirror that order here.
    await client.options.ticket();
    expect(client.options.auth()?.firebaseIdToken).toBe("firebase-proof");
  });

  it("STOP ends the session, releases the lease, and lands idle", async () => {
    const { capture } = mount();
    await act(async () => {
      await controller!.start();
    });
    expect(screen.getByTestId("phase").textContent).toBe("listening");
    await act(async () => {
      requestAgentConversationStop();
    });
    expect(screen.getByTestId("phase").textContent).toBe("idle");
    expect(FakeClient.instances[0]?.closeReasons).toEqual(["local:stop_event"]);
    expect(capture.stopped).toBe(1);
    expect(harness.leases[0]?.released.length).toBeGreaterThan(0);
  });

  it("a second request while running is the toggle: it ends the session", async () => {
    mount();
    await act(async () => {
      await controller!.start();
    });
    await act(async () => {
      requestAgentConversation();
    });
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("idle"),
    );
  });

  it("cancelling a pending native request stops it; a foreign cancel is ignored", async () => {
    let releaseTicket: (() => void) | null = null;
    const { rerender } = mount();
    rerender(
      <VoiceSessionProvider
        enabled
        deps={{
          createClient: (options) => new FakeClient(options),
          createCapture: () => new FakeCapture(),
          createPlayback: () => playback,
          createAudioContext: () => null,
          mintTicket: () =>
            new Promise((resolve) => {
              releaseTicket = () =>
                resolve({ ticket: "t", wsPath: "/api/one/voice/live" });
            }),
        }}
      >
        <Probe />
      </VoiceSessionProvider>,
    );
    await act(async () => {
      requestAgentConversation({
        source: "siri_app_shortcut",
        requestId: "siri-2",
      });
    });
    expect(screen.getByTestId("phase").textContent).toBe("connecting");
    await act(async () => {
      cancelAgentConversationRequest({
        source: "siri_app_shortcut",
        requestId: "someone-else",
      });
    });
    expect(screen.getByTestId("phase").textContent).toBe("connecting");
    await act(async () => {
      cancelAgentConversationRequest({
        source: "siri_app_shortcut",
        requestId: "siri-2",
      });
    });
    expect(screen.getByTestId("phase").textContent).toBe("idle");
    await act(async () => {
      releaseTicket?.();
    });
    expect(screen.getByTestId("phase").textContent).toBe("idle");
  });

  it("a locked vault opens the unlock dialog instead of a session", async () => {
    harness.vault = { isVaultUnlocked: false, vaultOwnerToken: "" };
    const received = outcomes();
    mount();
    await act(async () => {
      requestAgentConversation({ requestId: "req-locked" });
    });
    expect(screen.getByRole("dialog").textContent).toBe(
      "Unlock to talk to One",
    );
    expect(FakeClient.instances).toHaveLength(0);
    expect(harness.leases).toHaveLength(0);
    // The dialog owns the gesture, as with the bounded owner.
    await waitFor(() => expect(received[0]?.outcome).toBe("accepted"));
  });

  it("voice turned off in preferences refuses with a local error and no session", async () => {
    updateVoicePreferences("owner-1", (current) => ({
      ...current,
      voiceEnabled: false,
    }));
    const received = outcomes();
    mount();
    await act(async () => {
      requestAgentConversation({ requestId: "req-off" });
    });
    expect(FakeClient.instances).toHaveLength(0);
    expect(controller!.state.error?.code).toBe("voice_disabled");
    expect(controller!.state.phase).toBe("idle");
    await waitFor(() => expect(received[0]?.outcome).toBe("failed"));
  });

  it("holds a single lease per session and ends when it is revoked", async () => {
    mount();
    await act(async () => {
      await controller!.start();
      await controller!.start();
    });
    expect(harness.leases).toHaveLength(1);
    expect(FakeClient.instances).toHaveLength(1);
    await act(async () => {
      harness.leases[0]!.onRevoked("superseded_by_newer_voice_session");
    });
    expect(screen.getByTestId("phase").textContent).toBe("idle");
    expect(FakeClient.instances[0]?.closeReasons[0]).toContain("lease_revoked");
  });

  it("keeps one session through route changes and pauses capture until foreground", async () => {
    const { capture, deps, rerender } = mount();
    await act(async () => {
      await controller!.start();
    });
    const client = FakeClient.instances[0]!;
    await act(async () => client.options.onFrame({
      type: "transcript.input", turn_id: "before-navigation", text: "Keep this question", final: true,
    }));
    harness.pathname = "/one/connect";
    rerender(
      <VoiceSessionProvider enabled deps={deps}>
        <Probe />
      </VoiceSessionProvider>,
    );
    expect(FakeClient.instances).toHaveLength(1);
    expect(client.sent).toContain("app_context");
    expect(screen.getByTestId("phase").textContent).toBe("understanding");
    for (let index = 0; index < 9; index += 1) {
      harness.pathname = ["/one", "/one/connect", "/one/location"][index % 3]!;
      rerender(
        <VoiceSessionProvider enabled deps={deps}>
          <Probe />
        </VoiceSessionProvider>,
      );
    }
    expect(FakeClient.instances).toHaveLength(1);
    expect(capture.started).toBe(1);
    expect(controller!.state.transcript.some((item) => item.text === "Keep this question")).toBe(true);

    await act(async () => publishLifecycle("background"));
    expect(screen.getByTestId("phase").textContent).toBe("paused");
    expect(capture.stopped).toBe(1);
    expect(client.closeReasons).toEqual([]);

    await act(async () => publishLifecycle("active"));
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("listening"),
    );
    expect(FakeClient.instances).toHaveLength(1);
    expect(capture.started).toBe(2);
    expect(harness.leases).toHaveLength(2);
    await act(async () => publishLifecycle("active"));
    expect(capture.started).toBe(2);
  });

  it("reopens the same conversation after an abnormal network close", async () => {
    const { capture } = mount();
    await act(async () => controller!.start());
    const first = FakeClient.instances[0]!;
    const conversationId = first.options.auth()!.conversationId;
    await act(async () => first.options.onFrame({
      type: "transcript.input", turn_id: "before-network", text: "Earlier question", final: true,
    }));
    await act(async () => first.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(2));
    await waitFor(() => expect(controller!.state.phase).toBe("listening"));
    expect(FakeClient.instances[1]!.options.auth()!.conversationId).toBe(conversationId);
    expect(capture.started).toBe(2);
    expect(controller!.state.transcript.some((item) => item.text === "Earlier question")).toBe(true);
  });

  it("retries a failed immediate reconnect while the browser still reports online", async () => {
    mount();
    await act(async () => controller!.start());
    const first = FakeClient.instances[0]!;
    const conversationId = first.options.auth()!.conversationId;
    vi.spyOn(FakeClient.prototype, "connect").mockRejectedValueOnce(
      new Error("temporary network failure"),
    );
    await act(async () => first.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(2));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(3), { timeout: 3500 });
    await waitFor(() => expect(controller!.state.phase).toBe("listening"));
    expect(FakeClient.instances[2]!.options.auth()!.conversationId).toBe(conversationId);
  });

  it("waits for internet restoration before reopening a lost connection", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mount();
    await act(async () => controller!.start());
    const first = FakeClient.instances[0]!;
    const conversationId = first.options.auth()!.conversationId;
    await act(async () => first.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    expect(FakeClient.instances).toHaveLength(1);
    expect(controller!.state.phase).toBe("idle");
    expect(controller!.state.error?.code).toBe("network_lost");
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(2));
    expect(FakeClient.instances[1]!.options.auth()!.conversationId).toBe(conversationId);
  });

  it("reopens a backgrounded conversation when a lost socket returns to foreground", async () => {
    mount();
    await act(async () => controller!.start());
    const first = FakeClient.instances[0]!;
    const conversationId = first.options.auth()!.conversationId;
    await act(async () => publishLifecycle("background"));
    await act(async () => first.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    expect(FakeClient.instances).toHaveLength(1);
    await act(async () => publishLifecycle("active"));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(2));
    expect(FakeClient.instances[1]!.options.auth()!.conversationId).toBe(conversationId);
  });

  it("defers a relay-requested reconnect until internet returns", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mount();
    await act(async () => controller!.start());
    const first = FakeClient.instances[0]!;
    const conversationId = first.options.auth()!.conversationId;
    await act(async () => first.options.onFrame({
      type: "session.reconnect_required", reason: "go_away",
    }));
    online.mockReturnValue(false);
    await act(async () => first.options.onClose({
      code: 1000, reason: "go_away", clean: true, resumable: false,
    }));
    expect(FakeClient.instances).toHaveLength(1);
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(2));
    expect(FakeClient.instances[1]!.options.auth()!.conversationId).toBe(conversationId);
  });

  it("does not reconnect after Stop or account loss", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { deps, rerender } = mount();
    await act(async () => controller!.start());
    await act(async () => FakeClient.instances[0]!.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    await act(async () => controller!.stop());
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(FakeClient.instances).toHaveLength(1);

    online.mockReturnValue(false);
    await act(async () => controller!.start());
    await act(async () => FakeClient.instances[1]!.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    harness.user = null;
    rerender(
      <VoiceSessionProvider enabled deps={deps}>
        <Probe />
      </VoiceSessionProvider>,
    );
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(FakeClient.instances).toHaveLength(2);
  });

  it("retains a deferred retry when the first restoration attempt fails", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mount();
    await act(async () => controller!.start());
    await act(async () => FakeClient.instances[0]!.options.onClose({
      code: 1006, reason: "abnormal", clean: false, resumable: true,
    }));
    vi.spyOn(FakeClient.prototype, "connect").mockRejectedValueOnce(
      new Error("temporary network failure"),
    );
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(2));
    await act(async () => window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(FakeClient.instances).toHaveLength(3));
    await waitFor(() => expect(controller!.state.phase).toBe("listening"));
  });

  it("keeps the UI paused if session.ready arrives after capture was backgrounded", async () => {
    mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    await act(async () => publishLifecycle("background"));
    expect(controller!.state.phase).toBe("paused");
    await act(async () => client.options.onFrame(readyFrame({
      conversation_id: client.options.auth()!.conversationId,
    })));
    expect(controller!.state.phase).toBe("paused");
    await act(async () => publishLifecycle("active"));
    await waitFor(() => expect(controller!.state.phase).toBe("listening"));
    expect(FakeClient.instances).toHaveLength(1);
  });

  it("repairs a silently ended microphone track after an in-app route switch", async () => {
    const { capture, deps, rerender } = mount();
    await act(async () => {
      await controller!.start();
    });
    let firstCheck = true;
    capture.isTrackLive = () => {
      if (firstCheck) {
        firstCheck = false;
        return false;
      }
      return true;
    };

    harness.pathname = "/one/connect";
    rerender(
      <VoiceSessionProvider enabled deps={deps}>
        <Probe />
      </VoiceSessionProvider>,
    );

    await waitFor(() => expect(capture.started).toBe(2));
    expect(controller!.state.phase).toBe("listening");
    expect(FakeClient.instances).toHaveLength(1);
  });

  it("starts a new capture and lease after background interrupts an in-flight resume", async () => {
    const { deps, rerender } = mount();
    const captures: FakeCapture[] = [];
    let finishStaleStart!: () => void;
    deps.createCapture = () => {
      const capture = new FakeCapture();
      if (captures.length === 1) {
        capture.start = async (options) => {
          capture.started += 1;
          capture.options = options;
          await new Promise<void>((resolve) => {
            finishStaleStart = resolve;
          });
          return { sampleRate: 48_000, echoCancellation: true };
        };
      }
      captures.push(capture);
      return capture;
    };
    rerender(
      <VoiceSessionProvider enabled deps={deps}>
        <Probe />
      </VoiceSessionProvider>,
    );
    await act(async () => {
      await controller!.start();
    });
    const client = FakeClient.instances[0]!;

    await act(async () => publishLifecycle("background"));
    await act(async () => publishLifecycle("active"));
    expect(captures).toHaveLength(2);
    await act(async () => publishLifecycle("background"));
    expect(controller!.state.phase).toBe("paused");
    await act(async () => publishLifecycle("active"));
    await waitFor(() => expect(controller!.state.phase).toBe("listening"));
    await act(async () => finishStaleStart());

    expect(captures).toHaveLength(3);
    expect(captures[1]!.stopped).toBeGreaterThan(0);
    expect(captures[2]!.stopped).toBe(0);
    expect(harness.leases).toHaveLength(3);
    expect(FakeClient.instances).toEqual([client]);
  });

  it("offers retry with the same conversation after a hidden relay idle close", async () => {
    mount();
    await act(async () => {
      await controller!.start();
    });
    const conversationId =
      FakeClient.instances[0]!.options.auth()!.conversationId;
    await act(async () => publishLifecycle("background"));
    await act(async () =>
      FakeClient.instances[0]!.options.onClose({
        code: 4009,
        reason: "idle",
        clean: true,
        resumable: true,
      }),
    );
    expect(controller!.state.phase).toBe("idle");
    expect(controller!.state.error?.code).toBe("voice_pause_expired");

    await act(async () => publishLifecycle("active"));
    expect(FakeClient.instances).toHaveLength(1);
    await act(async () => {
      await controller!.start();
    });
    expect(FakeClient.instances[1]!.options.auth()!.conversationId).toBe(
      conversationId,
    );
  });

  it("does not claim to listen when the OS ends the microphone track", async () => {
    const { capture } = mount();
    await act(async () => {
      await controller!.start();
    });
    await act(async () => capture.options?.onEnded?.());
    expect(controller!.state.phase).not.toBe("listening");
    expect(controller!.state.error?.code).toBe("mic_ended");
    expect(capture.stopped).toBe(1);
    expect(FakeClient.instances[0]?.closeReasons).toEqual([]);
  });

  it("disabling the owner ends a running session and stops answering requests", async () => {
    const { rerender } = mount();
    await act(async () => {
      await controller!.start();
    });
    rerender(
      <VoiceSessionProvider
        enabled={false}
        deps={{ createClient: (options) => new FakeClient(options) }}
      >
        <Probe />
      </VoiceSessionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("idle"),
    );
    expect(isAgentConversationOwnerReady()).toBe(false);
    await act(async () => {
      requestAgentConversation();
    });
    expect(FakeClient.instances).toHaveLength(1);
  });

  it("locking the vault mid-session ends it", async () => {
    const { rerender } = mount();
    await act(async () => {
      await controller!.start();
    });
    harness.vault = { isVaultUnlocked: false, vaultOwnerToken: "" };
    rerender(
      <VoiceSessionProvider
        enabled
        deps={{ createClient: (options) => new FakeClient(options) }}
      >
        <Probe />
      </VoiceSessionProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase").textContent).toBe("idle"),
    );
    expect(FakeClient.instances[0]?.closeReasons).toEqual([
      "local:vault_locked",
    ]);
  });
});

describe("VoiceSessionProvider open mail row and Send reports", () => {
  const DELIVERY_REF = "Zr4mQ8vX2kLp9TnB_wYc7H-E";
  const ACTION_ID = "6f1c2b9a-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
  const namesMailRow = (context: AppContextInput | undefined) =>
    context !== undefined &&
    ("active_mail_ordinal" in context || "active_mail_offer_revision" in context);

  function rerenderProvider(view: ReturnType<typeof mount>) {
    view.rerender(
      <VoiceSessionProvider enabled deps={view.deps}>
        <Probe />
      </VoiceSessionProvider>,
    );
  }

  function routeTo(view: ReturnType<typeof mount>, pathname: string) {
    harness.pathname = pathname;
    rerenderProvider(view);
  }

  it("keeps the open row and Send reports away from a relay that does not list them", async () => {
    mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const conversationId = client.options.auth()!.conversationId;
    // An older or rolled-back relay advertises no features, and would refuse
    // the keys (dropping the whole app_context) and the report frame outright.
    await act(async () =>
      client.options.onFrame(readyFrame({ conversation_id: conversationId, features: undefined })),
    );

    await act(async () =>
      controller!.setActiveMail!({ ordinal: 2, offerRevision: 7, conversationId }),
    );
    await act(async () => controller!.reportMailDelivery!(DELIVERY_REF, ACTION_ID));

    expect(client.appContexts.some(namesMailRow)).toBe(false);
    expect(client.mailDeliveries).toEqual([]);
  });

  it("names the open mail row on every app_context of its conversation until it is closed", async () => {
    const view = mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const conversationId = client.options.auth()!.conversationId;
    const contexts = client.appContexts;
    const readyCount = contexts.length;
    expect(readyCount).toBeGreaterThan(0);
    expect(namesMailRow(contexts.at(-1))).toBe(false);

    await act(async () =>
      controller!.setActiveMail!({ ordinal: 2, offerRevision: 7, conversationId }),
    );
    expect(contexts).toHaveLength(readyCount + 1);
    expect(contexts.at(-1)).toMatchObject({
      active_mail_ordinal: 2,
      active_mail_offer_revision: 7,
    });

    // The same row again, as a fresh object, is not news to the relay.
    await act(async () =>
      controller!.setActiveMail!({ ordinal: 2, offerRevision: 7, conversationId }),
    );
    expect(contexts).toHaveLength(readyCount + 1);

    // A frame sent for another reason still names the row: each app_context
    // replaces the relay's whole screen context.
    routeTo(view, "/one/connect");
    expect(contexts.at(-1)).toMatchObject({
      route: "/one/connect",
      active_mail_ordinal: 2,
      active_mail_offer_revision: 7,
    });

    // Closing the row resends the context with both keys omitted, never null.
    const beforeClose = contexts.length;
    await act(async () => controller!.setActiveMail!(null));
    expect(contexts).toHaveLength(beforeClose + 1);
    expect(namesMailRow(contexts.at(-1))).toBe(false);
  });

  it("never names a row from another conversation's offer: its position means nothing here", async () => {
    const view = mount();
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    const otherConversationId = "22222222-3333-4444-8555-666666666666";
    expect(client.options.auth()!.conversationId).not.toBe(otherConversationId);

    await act(async () =>
      controller!.setActiveMail!({
        ordinal: 2,
        offerRevision: 7,
        conversationId: otherConversationId,
      }),
    );
    routeTo(view, "/one/connect");

    expect(client.appContexts.at(-1)).toMatchObject({ route: "/one/connect" });
    expect(client.appContexts.some(namesMailRow)).toBe(false);
  });

  it("forgets the open mail row when the account changes, even under a reused conversation id", async () => {
    // Pin the conversation id so the conversation check cannot be what keeps
    // the old account's row off the new account's relay.
    const conversationId = "33333333-4444-4555-8666-777777777777";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(conversationId);
    const view = mount();
    await act(async () => controller!.start());
    await act(async () =>
      controller!.setActiveMail!({ ordinal: 2, offerRevision: 7, conversationId }),
    );

    // Negative control: a restart on the same account continues the same
    // conversation, so its first app_context still names the row.
    await act(async () => controller!.stop());
    await act(async () => controller!.start());
    expect(FakeClient.instances).toHaveLength(2);
    expect(FakeClient.instances[1]!.appContexts.at(-1)).toMatchObject({
      active_mail_ordinal: 2,
      active_mail_offer_revision: 7,
    });

    harness.user = { uid: "owner-2" };
    updateVoicePreferences("owner-2", (current) => ({
      ...current,
      voiceEnabled: true,
    }));
    rerenderProvider(view);
    await act(async () => controller!.start());
    expect(FakeClient.instances).toHaveLength(3);
    const next = FakeClient.instances[2]!;
    expect(next.options.auth()!.conversationId).toBe(conversationId);
    expect(next.appContexts.length).toBeGreaterThan(0);
    expect(next.appContexts.some(namesMailRow)).toBe(false);
  });

  it("reports a finished Send to the live session once, and drops it when no session is live", async () => {
    mount();
    // Before any session: dropped, not held for the next one.
    await act(async () => controller!.reportMailDelivery!(DELIVERY_REF, ACTION_ID));
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    expect(client.mailDeliveries).toEqual([]);

    await act(async () => controller!.reportMailDelivery!(DELIVERY_REF, ACTION_ID));
    expect(client.mailDeliveries).toEqual([[DELIVERY_REF, ACTION_ID]]);

    // A Send that finishes after Stop has no relay left to tell.
    await act(async () => controller!.stop());
    await act(async () => controller!.reportMailDelivery!(DELIVERY_REF, ACTION_ID));
    expect(client.mailDeliveries).toEqual([[DELIVERY_REF, ACTION_ID]]);
  });
});

describe("VoiceSessionProvider typed name edit", () => {
  const CARD_ID = "11111111-aaaa-4bbb-8ccc-000000000001";
  const NEW_CARD_ID = "11111111-aaaa-4bbb-8ccc-000000000002";
  const circleCard = () =>
    pendingActionFrame({
      pending_action_id: CARD_ID,
      tool: "create_circle",
      gateway_action_id: "location.create_circle",
      summary: "create a friends circle called Hush Garage V4",
      args: { name: "Hush Garage V4", kind: "friends" },
      entities: [],
      receipt_token: undefined,
    });

  async function startWith(features: string[] | undefined) {
    await act(async () => controller!.start());
    const client = FakeClient.instances[0]!;
    await act(async () =>
      client.options.onFrame(
        readyFrame({ conversation_id: client.options.auth()!.conversationId, features }),
      ),
    );
    return client;
  }

  it("sends the exact frame to a relay that lists name_edit and answers with its own result", async () => {
    mount();
    const client = await startWith(["active_mail", "mail_delivery", "name_edit"]);
    let outcome: Awaited<ReturnType<NonNullable<VoiceSessionController["submitNameEdit"]>>> | null =
      null;
    await act(async () => {
      void controller!.submitNameEdit!(CARD_ID, "HUSSH GARAGE V04").then((value) => {
        outcome = value;
      });
    });
    expect(client.nameEdits).toHaveLength(1);
    const [pendingActionId, name, operationId] = client.nameEdits[0]!;
    expect([pendingActionId, name]).toEqual([CARD_ID, "HUSSH GARAGE V04"]);
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

    // Another operation's answer is not this one's.
    await act(async () =>
      client.options.onFrame({
        type: "name_edit.result",
        operation_id: "someone-else-1",
        status: "rejected",
        reason_code: "not_pending",
        message: "No.",
        pending_action_id: null,
      }),
    );
    expect(outcome).toBeNull();
    await act(async () =>
      client.options.onFrame({
        type: "name_edit.result",
        operation_id: operationId,
        status: "accepted",
        reason_code: null,
        message: null,
        pending_action_id: NEW_CARD_ID,
      }),
    );
    expect(outcome).toEqual({
      status: "accepted",
      reasonCode: null,
      message: null,
      pendingActionId: NEW_CARD_ID,
    });
  });

  it("never sends the frame to a relay that does not list it, and the panel offers no Edit name", async () => {
    mockVisiblePendingGeometry();
    mount(true, <PendingPanelProbe />);
    const client = await startWith(["active_mail", "mail_delivery"]);
    await act(async () => client.options.onFrame(circleCard()));
    expect(screen.getByTestId("one-voice-pending-action")).toBeTruthy();
    expect(screen.queryByTestId("one-voice-edit-name")).toBeNull();

    const outcome = await act(async () =>
      controller!.submitNameEdit!(CARD_ID, "HUSSH GARAGE V04"),
    );
    expect(outcome.status).toBe("rejected");
    expect(client.nameEdits).toEqual([]);
  });

  it("shows Edit name on the panel's create_circle card when the relay lists it", async () => {
    mockVisiblePendingGeometry();
    mount(true, <PendingPanelProbe />);
    const client = await startWith(["active_mail", "mail_delivery", "name_edit"]);
    await act(async () => client.options.onFrame(circleCard()));
    await act(async () => {
      screen.getByTestId("one-voice-edit-name").click();
    });
    await act(async () => {
      screen.getByTestId("one-voice-name-edit-review").click();
    });
    expect(client.nameEdits.map(([id, name]) => [id, name])).toEqual([
      [CARD_ID, "Hush Garage V4"],
    ]);
  });
});

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
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
import type {
  CaptureStartOptions,
  CaptureStartResult,
} from "@/lib/one-voice/audio/capture";
import type {
  LiveCloseInfo,
  OneLiveClientOptions,
} from "@/lib/one-voice/live-client";
import { useVoiceSessionStore } from "@/lib/one-voice/session-store";
import type { VoiceSessionController } from "@/lib/one-voice/session-types";

import { readyFrame } from "../../../__tests__/one-voice/fixtures/scripted-server";

const harness = vi.hoisted(() => ({
  vault: { isVaultUnlocked: true, vaultOwnerToken: "vault-owner-token" },
  user: { uid: "owner-1" } as { uid: string } | null,
  leases: [] as Array<{
    owner: string;
    onRevoked: (reason: string) => void;
    released: string[];
  }>,
  pathname: "/one/location",
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
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
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
  useVoiceSession,
} from "@/components/one-voice/voice-session-provider";

/** A client fake that answers connect() with session.ready and reports close. */
class FakeClient {
  static instances: FakeClient[] = [];
  readonly options: OneLiveClientOptions;
  readonly sent: string[] = [];
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
  sendAudio() {
    return this.isReady;
  }
  sendText(text: string) {
    this.sent.push(`text:${text}`);
    return true;
  }
  sendAppContext() {
    this.sent.push("app_context");
  }
  pendingShown() {
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
  clientStepResult() {
    return true;
  }
  uiSettled() {
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

const playback = {
  enqueue: () => true,
  flush: () => undefined,
  fenceTurn: () => undefined,
  onSpeakingChanged: () => () => undefined,
  close: () => undefined,
};

let controller: VoiceSessionController | null = null;
function Probe() {
  const session = useVoiceSession();
  useEffect(() => {
    controller = session;
  });
  return <output data-testid="phase">{session.state.phase}</output>;
}

function mount(enabled = true) {
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
  };
  const view = render(
    <VoiceSessionProvider enabled={enabled} deps={deps}>
      <Probe />
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
  harness.leases = [];
  harness.pathname = "/one/location";
  harness.lifecycle = "active";
  harness.lifecycleListeners.clear();
  harness.vault = {
    isVaultUnlocked: true,
    vaultOwnerToken: "vault-owner-token",
  };
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
    harness.pathname = "/one/connect";
    rerender(
      <VoiceSessionProvider enabled deps={deps}>
        <Probe />
      </VoiceSessionProvider>,
    );
    expect(FakeClient.instances).toHaveLength(1);
    expect(client.sent).toContain("app_context");
    expect(screen.getByTestId("phase").textContent).toBe("listening");

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

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CaptureStartOptions,
  CaptureStartResult,
} from "@/lib/one-voice/audio/capture";
import { OneLiveClient } from "@/lib/one-voice/live-client";
import { CLOSE_CODES } from "@/lib/one-voice/protocol";
import {
  VOICE_UNAVAILABLE_MESSAGE,
  selectSuccessReceipt,
} from "@/lib/one-voice/session-reducer";
import {
  useVoiceSessionStore,
  useVoiceToolEffects,
} from "@/lib/one-voice/session-store";
import type {
  VoiceSessionController,
  VoiceToolEffectHandlers,
} from "@/lib/one-voice/session-types";

import {
  ScriptedVoiceServer,
  pendingActionFrame,
} from "./fixtures/scripted-server";

const harness = vi.hoisted(() => ({
  pathname: "/one/location",
  vault: { isVaultUnlocked: true, vaultOwnerToken: "vault-owner-token" },
  user: { uid: "owner-1" } as { uid: string } | null,
  navigate: vi.fn(() => true),
  releases: [] as string[],
  leases: 0,
  revoke: null as ((reason: string) => void) | null,
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
vi.mock("@/components/vault/vault-unlock-dialog", () => ({
  VaultUnlockDialog: () => null,
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getFirebaseIdToken: vi.fn(async () => "firebase-proof") },
  normalizeNativeBackendUrl: (value: string) => value,
}));
vi.mock("@/lib/voice/voice-surface-metadata", () => ({
  getVoiceSurfaceMetadata: () => ({
    screenId: "one_location",
    availableActions: ["location.open_settings", "location.share_with"],
  }),
}));
vi.mock("@/lib/utils/browser-navigation", () => ({
  requestInternalAppNavigation: (value: unknown) =>
    harness.navigate(value as never),
}));
vi.mock("@/lib/navigation/profile-pane", () => ({
  requestProfilePaneOpen: vi.fn(),
}));
vi.mock("@/lib/interaction/interaction-intent-coordinator", () => ({
  appInteractionCoordinator: {
    acquireVoiceLease: ({
      owner,
      onRevoked,
    }: {
      owner: string;
      onRevoked: (reason: string) => void;
    }) => {
      harness.leases += 1;
      harness.revoke = onRevoked;
      return {
        id: `lease-${harness.leases}`,
        owner,
        isCurrent: () => true,
        release: (reason = "released") => {
          harness.releases.push(reason);
        },
      };
    },
  },
}));

import {
  VoiceSessionProvider,
  useVoiceSession,
} from "@/components/one-voice/voice-session-provider";

class FakeCapture {
  started = 0;
  stopped = 0;
  muted = false;
  frame: ((pcm16: Uint8Array) => void) | null = null;
  echoCancellation: boolean | null = true;
  async start(options: CaptureStartOptions): Promise<CaptureStartResult> {
    this.started += 1;
    this.frame = options.onFrame;
    return { sampleRate: 48_000, echoCancellation: this.echoCancellation };
  }
  setMuted(muted: boolean) {
    this.muted = muted;
  }
  stop() {
    this.stopped += 1;
    this.frame = null;
  }
}

class FakePlayback {
  enqueued: Array<{ bytes: number; turnId: string }> = [];
  flushes = 0;
  fenced: string[] = [];
  closed = false;
  private listeners = new Set<(speaking: boolean) => void>();
  enqueue(pcm16: Uint8Array, turnId: string) {
    this.enqueued.push({ bytes: pcm16.byteLength, turnId });
    return true;
  }
  flush() {
    this.flushes += 1;
  }
  fenceTurn(turnId: string) {
    this.fenced.push(turnId);
  }
  onSpeakingChanged(callback: (speaking: boolean) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  speak(speaking: boolean) {
    for (const listener of this.listeners) listener(speaking);
  }
  close() {
    this.closed = true;
  }
}

let controller: VoiceSessionController | null = null;

function Probe({ effects }: { effects?: VoiceToolEffectHandlers }) {
  const session = useVoiceSession();
  useVoiceToolEffects(effects ?? {});
  useEffect(() => {
    controller = session;
  });
  return <output data-testid="phase">{session.state.phase}</output>;
}

type Mounted = {
  server: ScriptedVoiceServer;
  capture: FakeCapture;
  playback: FakePlayback;
  unmount: () => void;
};

function mount(
  options: {
    effects?: VoiceToolEffectHandlers;
    enabled?: boolean;
    /**
     * The test override for the client-step budget. `null` leaves it unset so
     * the provider falls back to the server's `timeout_s` and its own default.
     */
    clientStepTimeoutMs?: number | null;
  } = {},
): Mounted {
  const server = new ScriptedVoiceServer();
  const capture = new FakeCapture();
  const playback = new FakePlayback();
  const view = render(
    <VoiceSessionProvider
      enabled={options.enabled ?? true}
      deps={{
        createClient: (clientOptions) =>
          new OneLiveClient({
            ...clientOptions,
            WebSocketImpl: server.WebSocketImpl,
            connectTimeoutMs: 0,
          }),
        createCapture: () => capture,
        createPlayback: () => playback,
        createAudioContext: () => null,
        mintTicket: async () => ({
          ticket: "ticket-1",
          wsPath: "/api/one/voice/live",
        }),
        getFirebaseIdToken: async () => "firebase-proof",
        afterPaint: (callback) => callback(),
        // Long enough that a busy runner cannot expire it between a pause
        // and the tap that resumes; short enough to observe the graced close.
        backgroundGraceMs: 400,
        ...(options.clientStepTimeoutMs === null
          ? {}
          : { clientStepTimeoutMs: options.clientStepTimeoutMs ?? 40 }),
        directiveClaimMs: 40,
      }}
    >
      <Probe effects={options.effects} />
    </VoiceSessionProvider>,
  );
  return { server, capture, playback, unmount: view.unmount };
}

async function startSession(mounted: Mounted) {
  await act(async () => {
    await controller!.start({ source: "test" });
  });
  await waitFor(() => expect(controller!.state.phase).toBe("listening"));
  return mounted;
}

const flush = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  useVoiceSessionStore.getState().reset();
  harness.releases = [];
  harness.leases = 0;
  harness.revoke = null;
  harness.navigate.mockClear();
  harness.pathname = "/one/location";
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  cleanup();
  controller = null;
  vi.useRealTimers();
});

describe("VoiceSessionProvider with a scripted relay", () => {
  it("sends auth first, lands listening on session.ready, then app_context", async () => {
    const mounted = mount();
    await startSession(mounted);
    const { server } = mounted;
    expect(server.urls[0]).toBe(
      "ws://localhost:8000/api/one/voice/live?ticket=ticket-1",
    );
    expect(server.sent[0]?.type).toBe("auth");
    const auth = server.frames("auth")[0]!;
    expect(auth.vault_owner_token).toBe("vault-owner-token");
    expect(auth.conversation_id).toHaveLength(36);
    expect(auth.resume).toBe(false);
    expect(controller!.state.sessionId).toBe("sess-1");
    expect(controller!.state.conversationId).toBe(auth.conversation_id);
    await waitFor(() => expect(server.frames("app_context")).toHaveLength(1));
    expect(server.frames("app_context")[0]).toMatchObject({
      screen_id: "one_location",
      route: "/one/location",
      available_action_ids: ["location.open_settings", "location.share_with"],
      os_location_permission: "unknown",
    });
    expect(harness.leases).toBe(1);
    expect(mounted.capture.started).toBe(1);
  });

  it("streams captured frames as audio and plays audio frames per turn; interrupt fences", async () => {
    const mounted = await startSession(mount());
    const { server, capture, playback } = mounted;
    await act(async () => {
      capture.frame?.(new Uint8Array(640));
    });
    expect(server.frames("audio").length).toBeGreaterThan(0);
    await act(async () => {
      server.push({
        type: "audio",
        data: btoa("    "),
        mime_type: "audio/pcm;rate=24000",
        turn_id: "t1",
      });
    });
    expect(playback.enqueued).toEqual([{ bytes: 4, turnId: "t1" }]);
    await act(async () => {
      playback.speak(true);
    });
    expect(controller!.state.speaking).toBe(true);
    await act(async () => {
      controller!.interrupt();
    });
    expect(playback.flushes).toBeGreaterThan(0);
    expect(playback.fenced).toContain("t1");
    expect(server.frames("interrupt")).toHaveLength(1);
    await act(async () => {
      server.push({ type: "turn", state: "interrupted", turn_id: "t1" });
    });
    expect(
      playback.fenced.filter((id) => id === "t1").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("acknowledges a card with pending_action.shown; confirm carries the receipt token", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    const card = pendingActionFrame();
    await act(async () => {
      server.push({ type: "state", state: "confirming" });
      server.push(card);
    });
    expect(controller!.state.phase).toBe("confirming");
    expect(controller!.state.pendingAction?.entities[0]?.display_name).toBe(
      "Priya",
    );
    expect(server.frames("pending_action.shown")).toEqual([
      {
        type: "pending_action.shown",
        pending_action_id: card.pending_action_id,
      },
    ]);
    await act(async () => {
      await controller!.confirmPending({ consentVersion: null });
    });
    expect(server.frames("confirm_action")).toEqual([
      {
        type: "confirm_action",
        pending_action_id: card.pending_action_id,
        receipt_token: "receipt-1",
        source: "tap",
        firebase_id_token: null,
        consent_version: null,
      },
    ]);
  });

  it("a second Confirm for the same card while the first is in flight sends nothing; the resolution unlocks the next card", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    const card = pendingActionFrame({
      tool: "trigger_save_my_soul",
      gateway_action_id: "location.trigger_sos",
      tier: "tap",
      requires_tap: true,
      receipt_token: "receipt-sos",
      entities: [],
    });
    await act(async () => {
      server.push({ type: "state", state: "confirming" });
      server.push(card);
    });
    // A double tap: both calls start before the relay has answered.
    await act(async () => {
      await Promise.all([
        controller!.confirmPending(),
        controller!.confirmPending(),
      ]);
    });
    expect(server.frames("confirm_action")).toHaveLength(1);
    expect(server.frames("confirm_action")[0]).toMatchObject({
      pending_action_id: card.pending_action_id,
      receipt_token: "receipt-sos",
    });
    // Still in flight: a later tap is dropped too.
    await act(async () => {
      await controller!.confirmPending();
    });
    expect(server.frames("confirm_action")).toHaveLength(1);

    // A refusal that keeps the card pending (a stale sign-in proof) is an
    // answer: the retry tap goes through with the same receipt.
    await act(async () => {
      server.push({
        type: "error",
        code: "firebase_proof_invalid",
        message: "Sign-in proof is invalid or names another account.",
      });
    });
    expect(controller!.state.pendingAction?.resolvedStatus).toBeNull();
    await act(async () => {
      await controller!.confirmPending();
    });
    expect(server.frames("confirm_action")).toHaveLength(2);
    await act(async () => {
      await controller!.confirmPending();
    });
    expect(server.frames("confirm_action")).toHaveLength(2);

    // The relay resolves the card armed (not sent); the same id resolving
    // again later must not be confused with a new card.
    await act(async () => {
      server.push({ type: "state", state: "executing" });
      server.push({
        type: "pending_action.resolved",
        pending_action_id: card.pending_action_id,
        status: "executed",
        result_public: { status: "sos_grants_created", grant_ids: ["g1"] },
      });
      server.push({ type: "state", state: "listening" });
    });
    expect(controller!.state.pendingAction?.resolvedStatus).toBe("executed");
    await act(async () => {
      await controller!.confirmPending();
    });
    expect(server.frames("confirm_action")).toHaveLength(2);

    // A new card confirms normally.
    const next = pendingActionFrame({
      pending_action_id: "11111111-0000-4000-8000-00000000abcd",
      tool: "stop_save_my_soul",
      gateway_action_id: "location.stop_sos",
      tier: "tap",
      requires_tap: true,
      receipt_token: "receipt-stop",
      entities: [],
    });
    await act(async () => {
      server.push(next);
    });
    await act(async () => {
      await controller!.confirmPending();
    });
    expect(server.frames("confirm_action")).toHaveLength(3);
    expect(server.frames("confirm_action")[2]).toMatchObject({
      pending_action_id: next.pending_action_id,
      receipt_token: "receipt-stop",
    });
  });

  it("a Firebase-plane tool's tap confirm includes the sign-in proof", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    const card = pendingActionFrame({
      tool: "update_display_name",
      gateway_action_id: "profile.update_display_name",
      tier: "tap",
      requires_tap: true,
      receipt_token: "receipt-name",
      entities: [],
    });
    await act(async () => {
      server.push(card);
    });
    await act(async () => {
      await controller!.confirmPending();
    });
    expect(server.frames("confirm_action")[0]).toMatchObject({
      receipt_token: "receipt-name",
      firebase_id_token: "firebase-proof",
    });
  });

  it("cancelPending sends cancel_action and the resolution clears the receipt", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    const card = pendingActionFrame();
    server.on("cancel_action", (frame) => ({
      type: "pending_action.resolved",
      pending_action_id: frame.pending_action_id!,
      status: "cancelled",
      result_public: null,
    }));
    await act(async () => {
      server.push(card);
    });
    await act(async () => {
      controller!.cancelPending();
    });
    expect(server.frames("cancel_action")).toEqual([
      {
        type: "cancel_action",
        pending_action_id: card.pending_action_id,
        scope: "pending_action",
      },
    ]);
    expect(controller!.state.pendingAction?.resolvedStatus).toBe("cancelled");
    expect(controller!.state.pendingAction?.receiptToken).toBeNull();
    expect(controller!.state.phase).toBe("listening");
    await act(async () => {
      controller!.cancelPending();
    });
    expect(server.frames("cancel_action")).toHaveLength(1);
  });

  it("fans out tool results and resolutions to screens after the reducer", async () => {
    const onToolResult = vi.fn();
    const onPendingResolved = vi.fn();
    const mounted = await startSession(
      mount({ effects: { onToolResult, onPendingResolved } }),
    );
    const { server } = mounted;
    await act(async () => {
      server.push({
        type: "tool.result",
        call_id: "c1",
        tool: "list_people",
        status: "no_connections",
        ok: true,
        result_public: { status: "no_connections" },
      });
    });
    expect(onToolResult).toHaveBeenCalledWith("list_people", {
      status: "no_connections",
    });
    expect(controller!.state.lastResult?.status).toBe("no_connections");
    const card = pendingActionFrame();
    await act(async () => {
      server.push(card);
      server.push({
        type: "pending_action.resolved",
        pending_action_id: card.pending_action_id,
        status: "executed",
        result_public: { status: "share_created" },
      });
    });
    expect(onPendingResolved).toHaveBeenCalledWith(
      card.pending_action_id,
      "executed",
      { status: "share_created" },
    );
    expect(controller!.state.phase).toBe("complete");
  });

  it("chooseCandidate answers the picker and dismisses it", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    await act(async () => {
      server.push({
        type: "candidate_picker",
        kind: "person",
        question: "Which Priya?",
        candidates: [{ user_id: "u-1", display_name: "Priya Sharma" }],
      });
    });
    expect(controller!.state.candidatePicker?.candidates[0]?.display_name).toBe(
      "Priya Sharma",
    );
    await act(async () => {
      controller!.chooseCandidate("u-1");
    });
    expect(server.frames("candidate.choose")).toEqual([
      { type: "candidate.choose", kind: "person", id: "u-1", none: false },
    ]);
    expect(controller!.state.candidatePicker).toBeNull();
  });

  it("client steps: a screen report goes out as client_step.result; no handler fails after the timeout", async () => {
    const onClientStep = vi.fn(
      (
        step: { stepId: string },
        report: (
          status: "ok" | "failed",
          payload?: Record<string, unknown>,
        ) => void,
      ) => {
        if (step.stepId === "step-1") report("ok", { published: 2 });
      },
    );
    const mounted = await startSession(mount({ effects: { onClientStep } }));
    const { server } = mounted;
    await act(async () => {
      server.push({
        type: "client_step.request",
        step_id: "step-1",
        kind: "publish_location_envelopes",
        payload: {},
        timeout_s: 20,
      });
    });
    expect(server.frames("client_step.result")).toEqual([
      {
        type: "client_step.result",
        step_id: "step-1",
        status: "ok",
        payload: { published: 2 },
      },
    ]);
    expect(controller!.state.clientStep).toBeNull();
    await act(async () => {
      server.push({
        type: "client_step.request",
        step_id: "step-2",
        kind: "request_os_permission",
        payload: {},
        timeout_s: 20,
      });
    });
    expect(controller!.state.clientStep?.stepId).toBe("step-2");
    await waitFor(() =>
      expect(server.frames("client_step.result")).toHaveLength(2),
    );
    expect(server.frames("client_step.result")[1]).toEqual({
      type: "client_step.result",
      step_id: "step-2",
      status: "failed",
      payload: { reason: "no_handler" },
    });
    expect(controller!.state.clientStep).toBeNull();
    // A late report for a step that already timed out is not sent twice.
    await act(async () => {
      controller!.reportClientStep("step-2", "ok");
    });
    expect(server.frames("client_step.result")).toHaveLength(2);
  });

  it("a generic directive with no screen runs the executor and settles; a screen that ignores it falls through", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    await act(async () => {
      server.push({
        type: "ui_directive",
        directive_id: "d-1",
        kind: "navigate",
        payload: {
          gateway_action_id: "location.open_circles",
          circle_id: "c-9",
        },
      });
    });
    await waitFor(() => expect(server.frames("ui.settled")).toHaveLength(1));
    expect(server.frames("ui.settled")[0]).toEqual({
      type: "ui.settled",
      directive_id: "d-1",
      status: "opened",
    });
    expect(harness.navigate).toHaveBeenCalledWith({
      href: "/one/location?view=circles&circle=c-9",
      source: "voice",
      transitionMode: "contextual",
    });
    // A screen-owned kind nobody settles is reported ignored after the step budget, never run here.
    await act(async () => {
      server.push({
        type: "ui_directive",
        directive_id: "d-2",
        kind: "request_os_permission",
        payload: {},
      });
    });
    await waitFor(() => expect(server.frames("ui.settled")).toHaveLength(2));
    expect(server.frames("ui.settled")[1]).toEqual({
      type: "ui.settled",
      directive_id: "d-2",
      status: "ignored",
    });
    expect(harness.navigate).toHaveBeenCalledTimes(1);
  });

  it("a screen that owns request_os_permission settles it; a screen that ignores navigate hands it to the executor", async () => {
    const onDirective = vi.fn(
      (
        _id: string,
        kind: string,
        _payload: Record<string, unknown>,
        settle: (status: "opened" | "failed" | "ignored") => void,
      ) => {
        settle(kind === "request_os_permission" ? "opened" : "ignored");
      },
    );
    const mounted = await startSession(mount({ effects: { onDirective } }));
    const { server } = mounted;
    await act(async () => {
      server.push({
        type: "ui_directive",
        directive_id: "d-3",
        kind: "request_os_permission",
        payload: {},
      });
    });
    expect(server.frames("ui.settled")[0]).toEqual({
      type: "ui.settled",
      directive_id: "d-3",
      status: "opened",
    });
    await act(async () => {
      server.push({
        type: "ui_directive",
        directive_id: "d-4",
        kind: "navigate",
        payload: { gateway_action_id: "location.open_settings" },
      });
    });
    await waitFor(() => expect(server.frames("ui.settled")).toHaveLength(2));
    expect(server.frames("ui.settled")[1]).toEqual({
      type: "ui.settled",
      directive_id: "d-4",
      status: "opened",
    });
    expect(harness.navigate).toHaveBeenCalledTimes(1);
  });

  it("stop sends end, closes, releases the lease and lands idle", async () => {
    const mounted = await startSession(mount());
    const { server, capture, playback } = mounted;
    await act(async () => {
      controller!.stop("tap");
    });
    await flush();
    expect(server.sequence().at(-1)).toBe("end");
    expect(server.socket.closeCalls[0]?.code).toBe(1000);
    expect(controller!.state.phase).toBe("idle");
    expect(controller!.state.error).toBeNull();
    expect(capture.stopped).toBe(1);
    expect(playback.closed).toBe(true);
    expect(harness.releases.length).toBeGreaterThan(0);
  });

  it("reconnects once with the same conversation after go_away, resuming", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    const first = server.frames("auth")[0]!;
    await act(async () => {
      server.push({ type: "session.reconnect_required", reason: "go_away" });
      server.close(CLOSE_CODES.ended, "go_away");
    });
    await waitFor(() => expect(server.sockets).toHaveLength(2));
    await waitFor(() => expect(controller!.state.phase).toBe("listening"));
    const second = server.frames("auth")[1]!;
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(second.resume).toBe(true);
    expect(controller!.state.error).toBeNull();
    expect(harness.leases).toBe(2);
    // A reconnect the relay refuses is reported once and never retried.
    server.ready = null;
    server.on("auth", () => ({
      type: "error",
      code: "ONE_VOICE_LIVE_DISABLED",
      message: "off",
    }));
    await act(async () => {
      server.push({
        type: "session.reconnect_required",
        reason: "max_duration",
      });
      server.close(CLOSE_CODES.maxDuration, "max_duration");
    });
    await waitFor(() => expect(server.sockets).toHaveLength(3));
    await waitFor(() => expect(controller!.state.phase).toBe("idle"));
    await flush();
    expect(server.sockets).toHaveLength(3);
    expect(controller!.state.error?.message).toBe(VOICE_UNAVAILABLE_MESSAGE);
  });

  it("stops reconnecting after the budget and reports the close", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        server.push({ type: "session.reconnect_required", reason: "go_away" });
        server.close(CLOSE_CODES.ended, "go_away");
      });
      await waitFor(() => expect(server.sockets).toHaveLength(round + 2));
      await waitFor(() => expect(controller!.state.phase).toBe("listening"));
    }
    await act(async () => {
      server.push({ type: "session.reconnect_required", reason: "go_away" });
      server.close(CLOSE_CODES.ended, "go_away");
    });
    await flush();
    expect(server.sockets).toHaveLength(4);
    expect(controller!.state.phase).toBe("idle");
    expect(controller!.state.reconnectReason).toBeNull();
  });

  it("never reconnects over an open card", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    await act(async () => {
      server.push(pendingActionFrame());
      server.push({ type: "session.reconnect_required", reason: "go_away" });
      server.close(CLOSE_CODES.ended, "go_away");
    });
    await flush();
    expect(server.sockets).toHaveLength(1);
    expect(controller!.state.phase).toBe("idle");
  });

  it("4013 explains that voice is unavailable and never retries", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    await act(async () => {
      server.close(CLOSE_CODES.providerUnavailable, "provider_unavailable");
    });
    await flush();
    expect(server.sockets).toHaveLength(1);
    expect(controller!.state.phase).toBe("idle");
    expect(controller!.state.error?.message).toBe(VOICE_UNAVAILABLE_MESSAGE);
    expect(controller!.state.error?.recoverable).toBe(false);
  });

  it("a later start reuses the page's conversation id", async () => {
    const mounted = await startSession(mount());
    const { server } = mounted;
    await act(async () => {
      controller!.stop("tap");
    });
    await flush();
    await startSession(mounted);
    const auths = server.frames("auth");
    expect(auths).toHaveLength(2);
    expect(auths[1]!.conversation_id).toBe(auths[0]!.conversation_id);
    expect(auths[1]!.resume).toBe(false);
  });

  it("backgrounding pauses: mic off, playback flushed, turn cancelled, then a graced close; a tap resumes", async () => {
    const mounted = await startSession(mount());
    const { server, capture, playback } = mounted;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(controller!.state.phase).toBe("paused");
    expect(capture.stopped).toBe(1);
    expect(playback.flushes).toBeGreaterThan(0);
    expect(server.frames("cancel_action")).toEqual([
      { type: "cancel_action", pending_action_id: null, scope: "turn" },
    ]);
    // Coming back does not turn the mic on by itself.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(controller!.state.phase).toBe("paused");
    expect(capture.started).toBe(1);
    // A tap resumes the same session before the grace runs out.
    await act(async () => {
      await controller!.start();
    });
    expect(capture.started).toBe(2);
    expect(controller!.state.phase).toBe("listening");
    expect(server.sockets).toHaveLength(1);
    // Pause again and let the grace expire.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(controller!.state.phase).toBe("idle"), {
      timeout: 2_000,
    });
    expect(server.sequence().at(-1)).toBe("end");
    expect(controller!.state.error).toBeNull();
  });

  it("mute keeps the session and drops frames; a revoked lease ends it", async () => {
    const mounted = await startSession(mount());
    const { server, capture } = mounted;
    await act(async () => {
      controller!.setMuted(true);
    });
    expect(capture.muted).toBe(true);
    expect(controller!.state.muted).toBe(true);
    await act(async () => {
      harness.revoke?.("superseded_by_newer_voice_session");
    });
    await flush();
    expect(controller!.state.phase).toBe("idle");
    expect(server.socket.closeCalls).toHaveLength(1);
  });

  it("sendText types into the live session and half-duplex gates the mic while One speaks", async () => {
    const mounted = mount();
    mounted.capture.echoCancellation = false;
    await startSession(mounted);
    const { server, capture, playback } = mounted;
    expect(controller!.state.halfDuplex).toBe(true);
    await act(async () => {
      controller!.sendText("share my location with Priya");
    });
    expect(server.frames("text")).toEqual([
      { type: "text", text: "share my location with Priya" },
    ]);
    const before = server.frames("audio").length;
    await act(async () => {
      playback.speak(true);
      capture.frame?.(new Uint8Array(640));
    });
    expect(server.frames("audio")).toHaveLength(before);
  });

  describe("client-step budget from the server's timeout_s", () => {
    // Freezes the clock only after the socket is open and listening so the
    // handshake keeps its real microtask timing; the step timer is then the
    // only thing that has to elapse.
    async function requestStepWithoutHandler(
      timeoutS: number | undefined,
      override: number | null = null,
    ) {
      const mounted = await startSession(
        mount({ clientStepTimeoutMs: override }),
      );
      const { server } = mounted;
      vi.useFakeTimers();
      await act(async () => {
        server.push({
          type: "client_step.request",
          step_id: "step-device",
          kind: "set_location_updates",
          payload: {
            desired_state: "on",
            gateway_action_id: "location.resume_updates",
          },
          // Omitted entirely when the server sent none.
          ...(timeoutS === undefined ? {} : { timeout_s: timeoutS }),
        } as never);
      });
      expect(controller!.state.clientStep?.stepId).toBe("step-device");
      return mounted;
    }

    const reportedAfter = (server: ScriptedVoiceServer) =>
      server.frames("client_step.result").filter(
        (frame) => frame.step_id === "step-device",
      );

    it("honours a server timeout_s of 40: no report at 25 s, the no_handler report at 40 s", async () => {
      const { server } = await requestStepWithoutHandler(40);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(25_000);
      });
      expect(reportedAfter(server)).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_999);
      });
      expect(reportedAfter(server)).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(reportedAfter(server)).toEqual([
        {
          type: "client_step.result",
          step_id: "step-device",
          status: "failed",
          payload: { reason: "no_handler" },
        },
      ]);
      expect(controller!.state.clientStep).toBeNull();
    });

    it("honours a server timeout_s of exactly 60 (the Save My Soul publish budget) in full", async () => {
      const { server } = await requestStepWithoutHandler(60);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(reportedAfter(server)).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(reportedAfter(server)).toHaveLength(1);
    });

    it("caps a server timeout_s of 90 at 60 s", async () => {
      const { server } = await requestStepWithoutHandler(90);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
      });
      expect(reportedAfter(server)).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(reportedAfter(server)).toHaveLength(1);
      expect(reportedAfter(server)[0]?.payload).toEqual({ reason: "no_handler" });
    });

    it("falls back to 25 s when the server sent no timeout_s", async () => {
      const { server } = await requestStepWithoutHandler(undefined);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(24_999);
      });
      expect(reportedAfter(server)).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(reportedAfter(server)).toHaveLength(1);
    });

    it("lets the deps clientStepTimeoutMs override win over a longer server budget", async () => {
      const { server } = await requestStepWithoutHandler(90, 40);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(39);
      });
      expect(reportedAfter(server)).toHaveLength(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(reportedAfter(server)).toHaveLength(1);
    });
  });

  it("a location_updates_pending tool.result is never a success receipt; the settled result replaces it", async () => {
    const onToolResult = vi.fn();
    const mounted = await startSession(mount({ effects: { onToolResult } }));
    const { server } = mounted;
    await act(async () => {
      server.push({ type: "state", state: "executing" });
      server.push({
        type: "tool.started",
        call_id: "c-device",
        tool: "resume_device_location_updates",
        args_public: {},
      });
      server.push({
        type: "tool.result",
        call_id: "c-device",
        tool: "resume_device_location_updates",
        status: "location_updates_pending",
        ok: false,
        result_public: { status: "location_updates_pending" },
      });
    });
    expect(controller!.state.lastResult?.status).toBe("location_updates_pending");
    expect(controller!.state.toolTimeline).toHaveLength(1);
    expect(controller!.state.toolTimeline[0]?.ok).toBe(false);
    expect(selectSuccessReceipt(controller!.state)).toBeNull();
    expect(controller!.state.phase).not.toBe("complete");
    expect(onToolResult).toHaveBeenCalledWith("resume_device_location_updates", {
      status: "location_updates_pending",
    });

    await act(async () => {
      server.push({
        type: "tool.result",
        call_id: "c-device",
        tool: "resume_device_location_updates",
        status: "on",
        ok: true,
        result_public: {
          status: "on",
          spoken_facts: ["Location is on."],
        },
      });
      server.push({ type: "state", state: "complete" });
    });
    expect(controller!.state.toolTimeline).toHaveLength(1);
    expect(controller!.state.toolTimeline[0]).toMatchObject({
      callId: "c-device",
      ok: true,
      result: { status: "on" },
    });
    expect(selectSuccessReceipt(controller!.state)).toMatchObject({
      source: "tool.result",
      tool: "resume_device_location_updates",
      status: "on",
    });
    expect(controller!.state.phase).toBe("complete");
  });
});

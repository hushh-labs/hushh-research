"use client";

/**
 * One Live Voice session owner: the SECOND microphone owner in the app.
 *
 * Mounted always (AgentOwnerGate) and active only while the server says Live
 * is on. When `enabled`, it is the conversation owner: it answers the shared
 * Talk-to-One request/stop/cancel events, announces itself owner-ready, and
 * holds the single voice lease while a session runs. It never reaches for
 * the bounded recorder or browser speech.
 *
 * Every server frame goes through the reducer FIRST (dispatchServerFrame);
 * side effects (playback, `pending_action.shown`, screen effects, generic
 * directives, client steps, reconnect) run after. UI success is never
 * decided here: it comes from `tool.result ok:true` and
 * `pending_action.resolved executed` in the reducer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useAgentRuntimeStateOptional } from "@/lib/agent/agent-runtime-context";
import {
  AGENT_CONVERSATION_CANCEL_EVENT,
  AGENT_CONVERSATION_REQUEST_EVENT,
  AGENT_CONVERSATION_STOP_EVENT,
  acknowledgeAgentConversation,
  markAgentConversationOwnerReady,
  type AgentConversationCancellation,
  type AgentConversationRequest,
} from "@/lib/agent/agent-voice-settings";
import { readVoicePreferences } from "@/lib/agent/voice-preferences";
import {
  appInteractionCoordinator,
  type VoiceSessionLease,
} from "@/lib/interaction/interaction-intent-coordinator";
import {
  ONE_VOICE_OS_PERMISSION_EVENT,
  buildAppContextFrame,
  deriveOsLocationPermission,
  type OneVoiceOsPermissionDetail,
} from "@/lib/one-voice/app-context";
import {
  LiveAudioCapture,
  MicCaptureError,
  type CaptureStartOptions,
  type CaptureStartResult,
} from "@/lib/one-voice/audio/capture";
import {
  HalfDuplexGate,
  decideHalfDuplex,
} from "@/lib/one-voice/audio/half-duplex";
import { bytesFromBase64 } from "@/lib/one-voice/audio/pcm";
import { LivePlaybackScheduler } from "@/lib/one-voice/audio/playback";
import { isFirebasePlaneTool } from "@/lib/one-voice/confirmation";
import type {
  AppContextInput,
  LiveCloseInfo,
  OneLiveClientOptions,
} from "@/lib/one-voice/live-client";
import type {
  ClientStepRequestFrame,
  OsPermission,
  ServerFrame,
  UiDirectiveFrame,
} from "@/lib/one-voice/protocol";
import {
  VOICE_UNAVAILABLE_MESSAGE,
  canAutoReconnect,
  hasOpenPendingAction,
  localCloseReason,
} from "@/lib/one-voice/session-reducer";
import {
  dispatchServerFrame,
  useVoiceSessionState,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";
import type {
  VoiceError,
  VoiceSessionController,
  VoiceSessionEvent,
  VoiceSessionState,
} from "@/lib/one-voice/session-types";
import type {
  VoiceClientKind,
  VoiceTicket,
  VoiceUnavailableReason,
} from "@/lib/one-voice/ticket";
import { useVault } from "@/lib/vault/vault-context";

// --- injectable dependencies --------------------------------------------------

/** The subset of OneLiveClient the provider uses; tests pass a fake. */
export interface VoiceLiveClientLike {
  readonly isReady: boolean;
  connect(): Promise<void>;
  close(reason?: string): void;
  sendAudio(pcm16: Uint8Array): boolean;
  sendText(text: string): boolean;
  sendAppContext(context: AppContextInput): void;
  pendingShown(pendingActionId: string): boolean;
  confirm(
    pendingActionId: string,
    options: {
      receiptToken: string | null;
      firebaseIdToken?: string | null;
      consentVersion?: string | null;
    },
  ): boolean;
  cancel(options: {
    pendingActionId?: string | null;
    scope: "pending_action" | "turn" | "session";
  }): boolean;
  chooseCandidate(options: {
    kind?: "person" | "circle";
    id?: string | null;
    none?: boolean;
  }): boolean;
  clientStepResult(
    stepId: string,
    status: "ok" | "failed",
    payload?: Record<string, unknown>,
  ): boolean;
  uiSettled(
    directiveId: string,
    status: "opened" | "failed" | "ignored",
  ): boolean;
  interrupt(): boolean;
}

export interface VoiceCaptureLike {
  start(options: CaptureStartOptions): Promise<CaptureStartResult>;
  setMuted(muted: boolean): void;
  stop(): void;
}

export interface VoicePlaybackLike {
  enqueue(pcm16: Uint8Array, turnId: string): boolean;
  flush(): void;
  fenceTurn(turnId: string): void;
  onSpeakingChanged(callback: (speaking: boolean) => void): () => void;
  close(): void;
}

export type VoiceSessionDeps = {
  createClient?: (
    options: OneLiveClientOptions,
  ) => VoiceLiveClientLike | Promise<VoiceLiveClientLike>;
  createCapture?: () => VoiceCaptureLike;
  createPlayback?: (context: AudioContext | null) => VoicePlaybackLike;
  /** Created from the user's gesture so Safari does not leave it suspended. */
  createAudioContext?: () => AudioContext | null;
  mintTicket?: (input: {
    vaultOwnerToken: string;
    conversationId: string;
    client: VoiceClientKind;
  }) => Promise<Pick<VoiceTicket, "ticket" | "wsPath">>;
  getFirebaseIdToken?: () => Promise<string | null | undefined>;
  /** "speakerphone-safe" forces half-duplex even with echo cancellation. */
  halfDuplexPreference?: () => "auto" | "speakerphone-safe";
  /** Runs a callback after the next paint (requestAnimationFrame by default). */
  afterPaint?: (callback: () => void) => void;
  now?: () => number;
  backgroundGraceMs?: number;
  clientStepTimeoutMs?: number;
  directiveClaimMs?: number;
};

export const ONE_VOICE_LEASE_OWNER = "one-voice-live" as const;
export const BACKGROUND_GRACE_MS = 20_000;
export const CLIENT_STEP_TIMEOUT_MS = 25_000;
/**
 * The most a server-advertised `timeout_s` may extend a client step. A device
 * step that navigates, may show the OS permission prompt, and then waits for
 * a fresh fix does not fit the 25 s default; the relay asks for 45 s.
 */
export const CLIENT_STEP_TIMEOUT_MAX_MS = 60_000;
/** How long a screen that registered `onDirective` has to claim a generic kind. */
export const DIRECTIVE_CLAIM_MS = 500;
const LEVEL_DISPATCH_INTERVAL_MS = 80;
const LEVEL_QUANTUM = 0.02;

function defaultCreateAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function defaultAfterPaint(callback: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(callback, 0);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

// The generic directive executor resolves gateway actions, which reaches
// api-service as well; it loads with the first directive.
type DirectivesModule = typeof import("@/lib/one-voice/directives");
let directivesModule: Promise<DirectivesModule> | null = null;
function loadDirectives(): Promise<DirectivesModule> {
  directivesModule ??= import("@/lib/one-voice/directives");
  return directivesModule;
}

type MintTicketInput = {
  vaultOwnerToken: string;
  conversationId: string;
  client: VoiceClientKind;
};

// The transport (socket client, ticket) reaches api-service and with it the
// native plugin registry. Loaded on the first tap, like the readiness probe,
// so the shell's module graph stays light and shell tests need no plugins.
async function defaultCreateClient(
  options: OneLiveClientOptions,
): Promise<VoiceLiveClientLike> {
  const { OneLiveClient } = await import("@/lib/one-voice/live-client");
  return new OneLiveClient(options);
}

async function defaultMintTicket(
  input: MintTicketInput,
): Promise<Pick<VoiceTicket, "ticket" | "wsPath">> {
  const { mintVoiceTicket } = await import("@/lib/one-voice/ticket");
  return mintVoiceTicket(input);
}

/** The `client` the backend records for the session: the running platform. */
function detectClientKind(): VoiceClientKind {
  const platform = Capacitor.getPlatform();
  if (platform === "ios") return "ios";
  if (platform === "android") return "android";
  return "web";
}

type VoiceUnavailableLike = Error & {
  reason: VoiceUnavailableReason;
  code: string | null;
};

function isVoiceUnavailable(error: unknown): error is VoiceUnavailableLike {
  return (
    error instanceof Error &&
    error.name === "VoiceUnavailableError" &&
    typeof (error as { reason?: unknown }).reason === "string"
  );
}

async function defaultGetFirebaseIdToken(): Promise<string | undefined> {
  // Lazy: the service pulls in the native plugin registry.
  const { ApiService } = await import("@/lib/services/api-service");
  return ApiService.getFirebaseIdToken();
}

function toVoiceError(error: unknown): VoiceError {
  if (error instanceof MicCaptureError) {
    return {
      code: `mic_${error.code}`,
      message: error.message,
      recoverable:
        error.code !== "not_supported" && error.code !== "worklet_unavailable",
    };
  }
  if (isVoiceUnavailable(error)) {
    const retryable = new Set([
      "network",
      "timeout",
      "rate_limited",
      "capacity",
    ]);
    // The relay's own wording is for logs; the person hears the one message
    // that also tells them typing still works.
    const unavailable = new Set([
      "provider_unavailable",
      "disabled",
      "not_configured",
      "unknown",
    ]);
    return {
      code: error.code || error.reason,
      message: unavailable.has(error.reason)
        ? VOICE_UNAVAILABLE_MESSAGE
        : error.message,
      recoverable: retryable.has(error.reason),
    };
  }
  return {
    code: "unknown",
    message:
      error instanceof Error && error.message
        ? error.message
        : "Voice could not start.",
    recoverable: false,
  };
}

// --- session record -----------------------------------------------------------

type BeginOutcome = "started" | "unlock_required" | "refused";

const MAX_FINISHED_STEPS = 50;
/** The server may ask for a fresh socket several times in a long conversation; a loop never. */
export const MAX_AUTO_RECONNECTS = 3;

function pruneFinishedSteps(steps: Map<string, ClientStepEntry>): void {
  let finished = 0;
  for (const entry of steps.values()) if (entry.done) finished += 1;
  if (finished <= MAX_FINISHED_STEPS) return;
  for (const [id, entry] of steps) {
    if (!entry.done) continue;
    steps.delete(id);
    finished -= 1;
    if (finished <= MAX_FINISHED_STEPS) break;
  }
}

type ClientStepEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
};

type LiveSession = {
  conversationId: string;
  isReconnect: boolean;
  client: VoiceLiveClientLike;
  capture: VoiceCaptureLike | null;
  playback: VoicePlaybackLike;
  audioContext: AudioContext | null;
  lease: VoiceSessionLease | null;
  gate: HalfDuplexGate | null;
  paused: boolean;
  stoppedLocally: boolean;
  tornDown: boolean;
  closeHandled: boolean;
  unsubscribes: Array<() => void>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  clientSteps: Map<string, ClientStepEntry>;
  directiveTimers: Set<ReturnType<typeof setTimeout>>;
  /**
   * The pending action whose tap confirm is in flight: sent (or being
   * prepared) and not yet resolved by the relay. A second Confirm for the
   * same card — a double tap, a re-render that fires twice, a spoken yes on
   * top of a tap — is dropped instead of sending a second `confirm_action`.
   * Cleared when the relay resolves that id, or when the session ends.
   */
  confirmingPendingId: string | null;
};

type DirectiveContext = {
  pathname: string | null;
  claimMs: number;
  screenTimeoutMs: number;
};

/**
 * Route one `ui_directive`. Screens first: a screen that does not own the
 * kind settles "ignored" and the generic executor takes over; a registered
 * screen that stays silent past the claim window is treated the same way.
 * Screen-owned kinds are never run here; with nobody to settle them they are
 * reported ignored after the step budget.
 */
function runDirective(
  session: LiveSession,
  frame: UiDirectiveFrame,
  directives: Pick<
    DirectivesModule,
    "executeDirective" | "isScreenOwnedDirective"
  >,
  context: DirectiveContext,
): void {
  const { executeDirective, isScreenOwnedDirective } = directives;
  const store = useVoiceSessionStore.getState();
  let settled = false;
  let claimTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (status: "opened" | "failed" | "ignored") => {
    if (settled) return;
    settled = true;
    if (claimTimer !== null) {
      clearTimeout(claimTimer);
      session.directiveTimers.delete(claimTimer);
      claimTimer = null;
    }
    if (!session.tornDown) session.client.uiSettled(frame.directive_id, status);
  };
  const runGeneric = () => {
    if (settled) return;
    void executeDirective(frame.kind, frame.payload || {}, {
      pathname: context.pathname,
    }).then(
      (outcome) => finish(outcome.handled ? outcome.status : "ignored"),
      () => finish("failed"),
    );
  };
  const screenOwned = isScreenOwnedDirective(frame.kind);
  const settle = (status: "opened" | "failed" | "ignored") => {
    if (status === "ignored" && !screenOwned) {
      runGeneric();
      return;
    }
    finish(status);
  };
  const handled = store.emitDirective(
    frame.directive_id,
    frame.kind,
    frame.payload || {},
    settle,
  );
  if (!handled) {
    if (screenOwned) finish("ignored");
    else runGeneric();
    return;
  }
  const waitMs = screenOwned ? context.screenTimeoutMs : context.claimMs;
  claimTimer = setTimeout(() => {
    if (claimTimer !== null) session.directiveTimers.delete(claimTimer);
    claimTimer = null;
    if (screenOwned) finish("ignored");
    else runGeneric();
  }, waitMs);
  session.directiveTimers.add(claimTimer);
}

const VoiceSessionContext = createContext<VoiceSessionController | null>(null);

// --- provider -----------------------------------------------------------------

export function VoiceSessionProvider({
  children,
  enabled,
  deps,
}: {
  children: ReactNode;
  enabled: boolean;
  deps?: VoiceSessionDeps;
}) {
  const { user } = useAuth();
  const { isVaultUnlocked, vaultOwnerToken } = useVault();
  const runtime = useAgentRuntimeStateOptional();
  const pathname = usePathname();
  const state = useVoiceSessionState();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [osPermissionOverride, setOsPermissionOverride] =
    useState<OsPermission | null>(null);

  // "Latest" refs for the socket callbacks and window listeners. Written in
  // an effect, never during render (react-hooks/refs); the callbacks that
  // read them only run after commit.
  const depsRef = useRef(deps);
  const latest = useRef({ user, isVaultUnlocked, vaultOwnerToken, enabled });
  // The Firebase proof fetched for the current connect attempt (see ticket()).
  const firebaseProofRef = useRef<string | null>(null);
  const runtimeRef = useRef(runtime);
  const pathnameRef = useRef(pathname);
  const osPermission: OsPermission =
    osPermissionOverride ?? deriveOsLocationPermission(runtime);
  const osPermissionRef = useRef(osPermission);
  useEffect(() => {
    depsRef.current = deps;
    latest.current = { user, isVaultUnlocked, vaultOwnerToken, enabled };
    runtimeRef.current = runtime;
    pathnameRef.current = pathname;
    osPermissionRef.current = osPermission;
  });

  const sessionRef = useRef<LiveSession | null>(null);
  /** Set while the client is loading, before a session exists to stop. */
  const openingRef = useRef<{ cancelled: boolean } | null>(null);
  /** One conversation per page session; reconnects and later taps reuse it. */
  const conversationIdRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const pendingExternalRequest = useRef<AgentConversationRequest | null>(null);
  const lastLevelDispatchRef = useRef({ at: 0, level: 0 });

  const dispatch = useCallback(
    (event: VoiceSessionEvent) =>
      useVoiceSessionStore.getState().dispatch(event),
    [],
  );
  const now = useCallback(() => depsRef.current?.now?.() ?? Date.now(), []);
  const readState = useCallback(
    (): VoiceSessionState => useVoiceSessionStore.getState().state,
    [],
  );

  // -- app context ------------------------------------------------------------

  const sendAppContext = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.tornDown) return;
    const frame = buildAppContextFrame({
      runtime: runtimeRef.current,
      pathname: pathnameRef.current,
      osLocationPermission: osPermissionRef.current,
    });
    const { type: _type, ...context } = frame;
    void _type;
    session.client.sendAppContext(context);
  }, []);

  // -- teardown / close --------------------------------------------------------

  const teardown = useCallback((session: LiveSession, reason: string) => {
    if (session.tornDown) return;
    session.tornDown = true;
    if (session.graceTimer !== null) {
      clearTimeout(session.graceTimer);
      session.graceTimer = null;
    }
    for (const entry of session.clientSteps.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    session.clientSteps.clear();
    for (const timer of session.directiveTimers) clearTimeout(timer);
    session.directiveTimers.clear();
    for (const unsubscribe of session.unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    try {
      session.capture?.stop();
    } catch {
      // ignore
    }
    session.capture = null;
    try {
      session.playback.flush();
      session.playback.close();
    } catch {
      // ignore
    }
    if (session.audioContext) {
      void session.audioContext.close().catch(() => undefined);
      session.audioContext = null;
    }
    session.lease?.release(reason);
    session.lease = null;
    if (sessionRef.current === session) sessionRef.current = null;
  }, []);

  const openSessionRef = useRef<
    (input: {
      conversationId: string;
      isReconnect: boolean;
    }) => Promise<boolean>
  >(async () => false);

  const reconnectsRef = useRef(0);

  const handleClose = useCallback(
    (session: LiveSession, info: LiveCloseInfo) => {
      if (session.closeHandled) return;
      session.closeHandled = true;
      teardown(session, `closed:${info.reason}`);
      const before = readState();
      const serverAsked = !session.stoppedLocally && canAutoReconnect(before);
      const reconnect =
        serverAsked &&
        latest.current.enabled &&
        reconnectsRef.current < MAX_AUTO_RECONNECTS;
      // The reducer reconnects on the reason alone; when this device refuses
      // (owner switched, budget spent) the close is reported as local so the
      // state lands idle instead of waiting on a socket that never opens.
      const reason =
        serverAsked && !reconnect ? localCloseReason(info.reason) : info.reason;
      dispatch({ type: "closed", code: info.code, reason, now: now() });
      if (reconnect) {
        reconnectsRef.current += 1;
        void openSessionRef.current({
          conversationId: session.conversationId,
          isReconnect: true,
        });
      }
    },
    [dispatch, now, readState, teardown],
  );

  const stopSession = useCallback(
    (reason: string) => {
      if (openingRef.current) openingRef.current.cancelled = true;
      const session = sessionRef.current;
      if (!session) return;
      session.stoppedLocally = true;
      // The client reports its close synchronously; handleClose tears down.
      session.client.close(localCloseReason(reason));
      if (!session.closeHandled) {
        handleClose(session, {
          code: 1000,
          reason: localCloseReason(reason),
          clean: true,
          resumable: false,
        });
      }
    },
    [handleClose],
  );
  const stopRef = useRef(stopSession);

  // -- frame side effects --------------------------------------------------------

  const settleDirective = useCallback(
    (session: LiveSession, frame: UiDirectiveFrame) => {
      void loadDirectives().then(
        (directives) => {
          if (sessionRef.current !== session || session.tornDown) return;
          runDirective(session, frame, directives, {
            pathname: pathnameRef.current,
            claimMs: depsRef.current?.directiveClaimMs ?? DIRECTIVE_CLAIM_MS,
            screenTimeoutMs:
              depsRef.current?.clientStepTimeoutMs ?? CLIENT_STEP_TIMEOUT_MS,
          });
        },
        () => {
          if (!session.tornDown)
            session.client.uiSettled(frame.directive_id, "failed");
        },
      );
    },
    [],
  );

  const reportClientStepFor = useCallback(
    (
      session: LiveSession,
      stepId: string,
      status: "ok" | "failed",
      payload?: Record<string, unknown>,
    ) => {
      // Only steps this session requested are reported, and only once: a
      // late report after the timeout (or a second report) is dropped.
      const entry = session.clientSteps.get(stepId);
      if (!entry || entry.done) return;
      entry.done = true;
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (!session.tornDown)
        session.client.clientStepResult(stepId, status, payload);
      dispatch({ type: "client_step_done", stepId });
    },
    [dispatch],
  );

  const requestClientStep = useCallback(
    (session: LiveSession, frame: ClientStepRequestFrame) => {
      const store = useVoiceSessionStore.getState();
      // A test override wins outright. Otherwise the server's own budget is
      // honoured up to a hard ceiling, and the default applies when it sends
      // none.
      const override = depsRef.current?.clientStepTimeoutMs;
      const serverLimit =
        Number.isFinite(frame.timeout_s) && frame.timeout_s > 0
          ? frame.timeout_s * 1000
          : null;
      const timeoutMs = Math.max(
        0,
        override !== undefined
          ? Math.min(override, serverLimit ?? override)
          : serverLimit === null
            ? CLIENT_STEP_TIMEOUT_MS
            : Math.min(serverLimit, CLIENT_STEP_TIMEOUT_MAX_MS),
      );
      const entry: ClientStepEntry = { timer: null, done: false };
      pruneFinishedSteps(session.clientSteps);
      session.clientSteps.set(frame.step_id, entry);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        reportClientStepFor(session, frame.step_id, "failed", {
          reason: "no_handler",
        });
      }, timeoutMs);
      store.emitClientStep(
        {
          stepId: frame.step_id,
          kind: frame.kind,
          payload: frame.payload || {},
          timeoutS: frame.timeout_s,
        },
        (status, payload) =>
          reportClientStepFor(session, frame.step_id, status, payload),
      );
    },
    [reportClientStepFor],
  );

  const handleFrame = useCallback(
    (session: LiveSession, frame: ServerFrame) => {
      if (sessionRef.current !== session || session.tornDown) return;
      dispatchServerFrame(frame, now());
      const store = useVoiceSessionStore.getState();
      switch (frame.type) {
        case "session.ready":
          sendAppContext();
          return;
        case "audio": {
          if (session.paused) return;
          try {
            session.playback.enqueue(
              bytesFromBase64(frame.data),
              frame.turn_id,
            );
          } catch {
            // A malformed chunk is dropped; the next one schedules normally.
          }
          return;
        }
        case "turn":
          if (frame.state === "interrupted")
            session.playback.fenceTurn(frame.turn_id);
          return;
        case "pending_action": {
          const id = frame.pending_action_id;
          (depsRef.current?.afterPaint ?? defaultAfterPaint)(() => {
            if (sessionRef.current === session && !session.tornDown)
              session.client.pendingShown(id);
          });
          return;
        }
        case "tool.result":
          store.emitToolResult(frame.tool, frame.result_public);
          return;
        case "pending_action.resolved":
          if (session.confirmingPendingId === frame.pending_action_id)
            session.confirmingPendingId = null;
          store.emitPendingResolved(
            frame.pending_action_id,
            frame.status,
            frame.result_public,
          );
          return;
        case "ui_directive":
          settleDirective(session, frame);
          return;
        case "client_step.request":
          requestClientStep(session, frame);
          return;
        case "error":
          // The relay answered the confirm with a refusal (a missing or
          // invalid sign-in proof keeps the card pending): the next tap is a
          // legitimate retry, not a duplicate.
          session.confirmingPendingId = null;
          return;
        default:
          return;
      }
    },
    [now, requestClientStep, sendAppContext, settleDirective],
  );

  // -- capture ------------------------------------------------------------------

  const dispatchLevel = useCallback(
    (level: number) => {
      const at = now();
      const quantized = Math.round(level / LEVEL_QUANTUM) * LEVEL_QUANTUM;
      const last = lastLevelDispatchRef.current;
      if (quantized === last.level) return;
      if (quantized !== 0 && at - last.at < LEVEL_DISPATCH_INTERVAL_MS) return;
      lastLevelDispatchRef.current = { at, level: quantized };
      dispatch({ type: "level", level: quantized });
    },
    [dispatch, now],
  );

  const startCapture = useCallback(
    async (session: LiveSession): Promise<void> => {
      const capture = (
        depsRef.current?.createCapture ?? (() => new LiveAudioCapture())
      )();
      session.capture = capture;
      capture.setMuted(mutedRef.current);
      const result = await capture.start({
        ...(session.audioContext ? { audioContext: session.audioContext } : {}),
        onFrame: (pcm16) => {
          if (
            sessionRef.current !== session ||
            session.tornDown ||
            session.paused
          )
            return;
          if (session.gate && !session.gate.allows()) return;
          session.client.sendAudio(pcm16);
        },
        onLevel: dispatchLevel,
      });
      if (sessionRef.current !== session || session.tornDown) {
        capture.stop();
        return;
      }
      const preference = depsRef.current?.halfDuplexPreference?.() ?? "auto";
      const halfDuplex = decideHalfDuplex({
        echoCancellation: result.echoCancellation,
        forced: preference === "speakerphone-safe",
      });
      session.gate = halfDuplex
        ? new HalfDuplexGate({ now: () => now() })
        : null;
      dispatch({ type: "half_duplex", enabled: halfDuplex });
    },
    [dispatch, dispatchLevel, now],
  );

  // -- open ---------------------------------------------------------------------

  const openSession = useCallback(
    async (input: {
      conversationId: string;
      isReconnect: boolean;
    }): Promise<boolean> => {
      if (sessionRef.current || openingRef.current) return false;
      dispatch({ type: "connecting", conversationId: input.conversationId });

      const audioContext = (
        depsRef.current?.createAudioContext ?? defaultCreateAudioContext
      )();
      const playback = (
        depsRef.current?.createPlayback ??
        ((context) => new LivePlaybackScheduler(context ? { context } : {}))
      )(audioContext);
      const clientKind = detectClientKind();
      const mint = depsRef.current?.mintTicket ?? defaultMintTicket;

      const session: LiveSession = {
        conversationId: input.conversationId,
        isReconnect: input.isReconnect,
        client: null as unknown as VoiceLiveClientLike,
        capture: null,
        playback,
        audioContext,
        lease: null,
        gate: null,
        paused: false,
        stoppedLocally: false,
        tornDown: false,
        closeHandled: false,
        unsubscribes: [],
        graceTimer: null,
        clientSteps: new Map(),
        directiveTimers: new Set(),
        confirmingPendingId: null,
      };
      const clientOptions: OneLiveClientOptions = {
        ticket: async () => {
          // A fresh sign-in proof rides the auth frame so a spoken yes on a
          // firebase-plane card can be verified without a tap. No proof is
          // not an error: the relay then asks for a tap, which carries one.
          firebaseProofRef.current =
            (await (
              depsRef.current?.getFirebaseIdToken ?? defaultGetFirebaseIdToken
            )().catch(() => null)) || null;
          const token = latest.current.vaultOwnerToken;
          if (!token) throw new Error("Unlock to talk to One.");
          const ticket = await mint({
            vaultOwnerToken: token,
            conversationId: input.conversationId,
            client: clientKind,
          });
          return { ticket: ticket.ticket, wsPath: ticket.wsPath };
        },
        auth: () => {
          const token = latest.current.vaultOwnerToken;
          if (!token) return null;
          return {
            vaultOwnerToken: token,
            firebaseIdToken: firebaseProofRef.current,
            conversationId: input.conversationId,
            client: clientKind,
          };
        },
        onFrame: (frame) => handleFrame(session, frame),
        onClose: (info) => handleClose(session, info),
        onDegraded: (degraded) => {
          if (sessionRef.current === session)
            dispatch({ type: "degraded", degraded });
        },
        resume: input.isReconnect,
      };
      // The client may load lazily; a stop that lands meanwhile cancels the
      // open before any socket exists.
      const opening = { cancelled: false };
      openingRef.current = opening;
      try {
        session.client = await (
          depsRef.current?.createClient ?? defaultCreateClient
        )(clientOptions);
      } catch (error) {
        openingRef.current = null;
        dispatch({
          type: "closed",
          code: 1000,
          reason: localCloseReason("client_unavailable"),
          now: now(),
        });
        dispatch({ type: "local_error", error: toVoiceError(error) });
        return false;
      }
      openingRef.current = null;
      if (opening.cancelled || sessionRef.current) {
        dispatch({
          type: "closed",
          code: 1000,
          reason: localCloseReason("cancelled"),
          now: now(),
        });
        return false;
      }
      sessionRef.current = session;

      session.lease = appInteractionCoordinator.acquireVoiceLease({
        owner: ONE_VOICE_LEASE_OWNER,
        onRevoked: (reason) => {
          if (sessionRef.current === session)
            stopRef.current(`lease_revoked:${reason}`);
        },
      });
      session.unsubscribes.push(
        playback.onSpeakingChanged((speaking) => {
          if (sessionRef.current !== session) return;
          session.gate?.onSpeaking(speaking);
          dispatch({ type: "speaking", speaking });
        }),
      );

      // The socket and the mic open together: frames captured before
      // `session.ready` sit in the client's bounded onset buffer.
      const [connected, captured] = await Promise.allSettled([
        session.client.connect(),
        startCapture(session),
      ]);
      if (sessionRef.current !== session || session.tornDown) return false;
      const failure =
        connected.status === "rejected"
          ? connected.reason
          : captured.status === "rejected"
            ? captured.reason
            : null;
      if (failure !== null) {
        const error = toVoiceError(failure);
        stopRef.current("start_failed");
        dispatch({ type: "local_error", error });
        return false;
      }
      return true;
    },
    [dispatch, handleClose, handleFrame, now, startCapture],
  );

  const resumeSession = useCallback(
    async (session: LiveSession): Promise<boolean> => {
      if (session.graceTimer !== null) {
        clearTimeout(session.graceTimer);
        session.graceTimer = null;
      }
      session.paused = false;
      if (session.audioContext && session.audioContext.state === "suspended") {
        await session.audioContext.resume().catch(() => undefined);
      }
      try {
        await startCapture(session);
      } catch (error) {
        if (sessionRef.current !== session) return false;
        stopRef.current("resume_failed");
        dispatch({ type: "local_error", error: toVoiceError(error) });
        return false;
      }
      if (sessionRef.current !== session || session.tornDown) return false;
      dispatch({ type: "resumed" });
      sendAppContext();
      return true;
    },
    [dispatch, sendAppContext, startCapture],
  );

  /**
   * Begin (or resume) a session. "unlock_required" means the unlock dialog
   * now owns the gesture; "refused" means nothing started.
   */
  const begin = useCallback(async (): Promise<BeginOutcome> => {
    if (!latest.current.enabled) return "refused";
    const running = sessionRef.current;
    if (running) {
      if (running.paused)
        return (await resumeSession(running)) ? "started" : "refused";
      return "refused";
    }
    const {
      isVaultUnlocked: unlocked,
      vaultOwnerToken: token,
      user: current,
    } = latest.current;
    if (!unlocked || !token) {
      setUnlockOpen(true);
      return "unlock_required";
    }
    if (!readVoicePreferences(current?.uid || null).voiceEnabled) {
      dispatch({
        type: "local_error",
        error: {
          code: "voice_disabled",
          message: "Turn voice on in your settings first.",
          recoverable: false,
        },
      });
      return "refused";
    }
    if (!conversationIdRef.current)
      conversationIdRef.current = crypto.randomUUID();
    reconnectsRef.current = 0;
    const opened = await openSession({
      conversationId: conversationIdRef.current,
      isReconnect: false,
    });
    return opened ? "started" : "refused";
  }, [dispatch, openSession, resumeSession]);
  const beginRef = useRef(begin);

  // -- pause on background --------------------------------------------------------

  const pause = useCallback(
    (reason: string) => {
      const session = sessionRef.current;
      if (!session || session.paused || session.tornDown) return;
      session.paused = true;
      try {
        session.capture?.stop();
      } catch {
        // ignore
      }
      session.capture = null;
      session.playback.flush();
      session.gate?.reset();
      session.client.cancel({ scope: "turn" });
      dispatch({ type: "paused" });
      const graceMs = depsRef.current?.backgroundGraceMs ?? BACKGROUND_GRACE_MS;
      session.graceTimer = setTimeout(() => {
        session.graceTimer = null;
        if (sessionRef.current === session)
          stopRef.current(`background:${reason}`);
      }, graceMs);
    },
    [dispatch],
  );
  const pauseRef = useRef(pause);
  useEffect(() => {
    stopRef.current = stopSession;
    openSessionRef.current = openSession;
    beginRef.current = begin;
    pauseRef.current = pause;
  }, [begin, openSession, pause, stopSession]);

  useEffect(() => {
    const background = () => {
      if (document.hidden) pauseRef.current("hidden");
    };
    document.addEventListener("visibilitychange", background);
    const handle = Capacitor.isNativePlatform()
      ? App.addListener("appStateChange", ({ isActive }) => {
          if (!isActive) pauseRef.current("inactive");
        })
      : null;
    return () => {
      document.removeEventListener("visibilitychange", background);
      void handle?.then((listener) => listener.remove());
    };
  }, []);

  // -- conversation ownership ------------------------------------------------------

  useEffect(() => {
    if (!enabled) return;
    const request = (event: Event) => {
      const value =
        (event as CustomEvent<AgentConversationRequest>).detail || {};
      const source = value.source || "agent_chat";
      const settle = (outcome: "accepted" | "failed") => {
        if (value.requestId && pendingExternalRequest.current !== value) return;
        pendingExternalRequest.current = null;
        if (value.requestId)
          acknowledgeAgentConversation({
            source,
            requestId: value.requestId,
            outcome,
          });
      };
      if (pendingExternalRequest.current) {
        if (value.requestId)
          acknowledgeAgentConversation({
            source,
            requestId: value.requestId,
            outcome: "failed",
          });
        return; // One owner, one request at a time.
      }
      if (value.requestId) pendingExternalRequest.current = value;
      const running = sessionRef.current;
      let work: Promise<boolean>;
      if (value.initialRequestText) {
        // A trusted native handoff: typed into the live session, never spoken by the app.
        const text = value.initialRequestText;
        work = (
          running && !running.paused
            ? Promise.resolve<BeginOutcome>("started")
            : beginRef.current()
        ).then((outcome) => {
          const session = sessionRef.current;
          if (outcome !== "started" || !session || session.tornDown)
            return false;
          session.client.sendText(text);
          return true;
        });
      } else if (running && !running.paused) {
        // The shared request is a toggle: a second one ends the session.
        stopRef.current("conversation_request");
        work = Promise.resolve(true);
      } else {
        // The unlock dialog owning the gesture counts as accepted, as with the
        // bounded owner: the person is now inside the flow.
        work = beginRef.current().then((outcome) => outcome !== "refused");
      }
      void work.then(
        (started) => settle(started ? "accepted" : "failed"),
        (error) => {
          settle("failed");
          dispatch({ type: "local_error", error: toVoiceError(error) });
        },
      );
    };
    const stop = () => {
      pendingExternalRequest.current = null;
      stopRef.current("stop_event");
    };
    const cancelPendingRequest = (event: Event) => {
      const cancellation = (event as CustomEvent<AgentConversationCancellation>)
        .detail;
      const pending = pendingExternalRequest.current;
      if (
        !pending ||
        !cancellation?.requestId ||
        pending.requestId !== cancellation.requestId ||
        pending.source !== cancellation.source
      )
        return;
      stop();
    };
    window.addEventListener(AGENT_CONVERSATION_REQUEST_EVENT, request);
    window.addEventListener(AGENT_CONVERSATION_STOP_EVENT, stop);
    window.addEventListener(
      AGENT_CONVERSATION_CANCEL_EVENT,
      cancelPendingRequest,
    );
    const release = markAgentConversationOwnerReady();
    return () => {
      release();
      window.removeEventListener(AGENT_CONVERSATION_REQUEST_EVENT, request);
      window.removeEventListener(AGENT_CONVERSATION_STOP_EVENT, stop);
      window.removeEventListener(
        AGENT_CONVERSATION_CANCEL_EVENT,
        cancelPendingRequest,
      );
    };
  }, [dispatch, enabled]);

  // Ownership handed away, vault locked, or unmount: the session ends.
  useEffect(() => {
    if (enabled) return;
    stopRef.current("disabled");
  }, [enabled]);
  useEffect(() => {
    if (isVaultUnlocked && vaultOwnerToken) return;
    stopRef.current("vault_locked");
  }, [isVaultUnlocked, vaultOwnerToken]);
  useEffect(() => {
    // A different account never continues the previous conversation.
    conversationIdRef.current = null;
    stopRef.current("account_changed");
  }, [user?.uid]);
  useEffect(() => () => stopRef.current("unmount"), []);

  // App context follows the route, the OS permission, and screen reports.
  useEffect(() => {
    sendAppContext();
  }, [pathname, osPermission, sendAppContext]);
  useEffect(() => {
    const onPermission = (event: Event) => {
      const detail = (event as CustomEvent<OneVoiceOsPermissionDetail>).detail;
      if (!detail || typeof detail.permission !== "string") return;
      setOsPermissionOverride(detail.permission);
    };
    window.addEventListener(ONE_VOICE_OS_PERMISSION_EVENT, onPermission);
    return () =>
      window.removeEventListener(ONE_VOICE_OS_PERMISSION_EVENT, onPermission);
  }, []);

  // -- controller ---------------------------------------------------------------

  const start = useCallback(async () => {
    await beginRef.current();
  }, []);

  const stop = useCallback((reason = "tap") => {
    pendingExternalRequest.current = null;
    stopRef.current(reason);
  }, []);

  const setMuted = useCallback(
    (muted: boolean) => {
      mutedRef.current = muted;
      sessionRef.current?.capture?.setMuted(muted);
      if (muted) dispatchLevel(0);
      dispatch({ type: "muted", muted });
    },
    [dispatch, dispatchLevel],
  );

  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.tornDown) return;
    session.playback.flush();
    const turnId = readState().turnId;
    if (turnId) session.playback.fenceTurn(turnId);
    session.client.interrupt();
  }, [readState]);

  const sendText = useCallback((text: string) => {
    const session = sessionRef.current;
    if (!session || session.tornDown) return;
    session.client.sendText(text);
  }, []);

  const confirmPending = useCallback(
    async (options?: { consentVersion?: string | null }) => {
      const session = sessionRef.current;
      const pending = readState().pendingAction;
      if (
        !session ||
        session.tornDown ||
        !pending ||
        pending.resolvedStatus !== null
      )
        return;
      const pendingId = pending.pending_action_id;
      // One confirm per card while the relay has not answered: a second tap
      // (or a spoken yes landing on top of it) must not send a second
      // `confirm_action`, which the server would refuse as `not_pending` and
      // which would race the receipt on the card.
      if (session.confirmingPendingId === pendingId) return;
      session.confirmingPendingId = pendingId;
      let firebaseIdToken: string | null = null;
      if (isFirebasePlaneTool(pending.tool)) {
        const token = await (
          depsRef.current?.getFirebaseIdToken ?? defaultGetFirebaseIdToken
        )().catch(() => null);
        firebaseIdToken = token || null;
      }
      if (sessionRef.current !== session || session.tornDown) return;
      // The card may have resolved (or been replaced) while the proof was
      // being fetched; the relay would only refuse the stale confirm.
      const latest = readState().pendingAction;
      if (
        !latest ||
        latest.pending_action_id !== pendingId ||
        latest.resolvedStatus !== null
      ) {
        if (session.confirmingPendingId === pendingId)
          session.confirmingPendingId = null;
        return;
      }
      const sent = session.client.confirm(pendingId, {
        receiptToken: pending.receiptToken,
        firebaseIdToken,
        consentVersion: options?.consentVersion ?? null,
      });
      if (sent === false && session.confirmingPendingId === pendingId) {
        // Nothing left the device; the next tap may try again.
        session.confirmingPendingId = null;
      }
    },
    [readState],
  );

  const cancelPending = useCallback(() => {
    const session = sessionRef.current;
    const current = readState();
    if (!session || session.tornDown || !hasOpenPendingAction(current)) return;
    session.client.cancel({
      pendingActionId: current.pendingAction!.pending_action_id,
      scope: "pending_action",
    });
  }, [readState]);

  const chooseCandidate = useCallback(
    (id: string | null) => {
      const session = sessionRef.current;
      const picker = readState().candidatePicker;
      if (!session || session.tornDown) return;
      session.client.chooseCandidate({
        ...(picker ? { kind: picker.kind } : {}),
        id,
        none: id === null,
      });
      dispatch({ type: "dismiss_candidates" });
    },
    [dispatch, readState],
  );

  const reportClientStep = useCallback(
    (
      stepId: string,
      status: "ok" | "failed",
      payload?: Record<string, unknown>,
    ) => {
      const session = sessionRef.current;
      if (!session || session.tornDown) return;
      reportClientStepFor(session, stepId, status, payload);
    },
    [reportClientStepFor],
  );

  const controller = useMemo<VoiceSessionController>(
    () => ({
      enabled,
      state,
      start,
      stop,
      setMuted,
      interrupt,
      sendText,
      confirmPending,
      cancelPending,
      chooseCandidate,
      reportClientStep,
    }),
    [
      enabled,
      state,
      start,
      stop,
      setMuted,
      interrupt,
      sendText,
      confirmPending,
      cancelPending,
      chooseCandidate,
      reportClientStep,
    ],
  );

  return (
    <VoiceSessionContext.Provider value={controller}>
      {children}
      {enabled && user ? (
        <VaultUnlockDialog
          user={user}
          open={unlockOpen}
          onOpenChange={setUnlockOpen}
          onSuccess={() => setUnlockOpen(false)}
          title="Unlock to talk to One"
          description="Unlock your vault, then tap Talk to One to start talking."
        />
      ) : null}
    </VoiceSessionContext.Provider>
  );
}

export function useVoiceSession(): VoiceSessionController {
  const value = useContext(VoiceSessionContext);
  if (!value) throw new Error("VoiceSessionProvider is required.");
  return value;
}

export function useOptionalVoiceSession(): VoiceSessionController | null {
  return useContext(VoiceSessionContext);
}

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
 * Turn-owned effects are fenced before dispatch. Admitted frames go through
 * the reducer before playback, screen effects, directives and client steps.
 * UI success is never
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
import { readSpeakerphoneSafePreference } from "@/lib/one-voice/speakerphone-preferences";
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
import {
  MailOpenError,
  openOfferedDraft,
  openOfferedMail,
} from "@/lib/one-voice/mail-open";
import { LivePlaybackScheduler } from "@/lib/one-voice/audio/playback";
import { performanceNow, SpeechEndProbe } from "@/lib/one-voice/performance";
import { isFirebasePlaneTool } from "@/lib/one-voice/confirmation";
import type {
  AppContextInput,
  LiveCloseInfo,
  OneLiveClientOptions,
} from "@/lib/one-voice/live-client";
import type {
  ClientStepRequestFrame,
  OsPermission,
  PerfFrame,
  ServerFrame,
  UiDirectiveFrame,
} from "@/lib/one-voice/protocol";
import { NAME_EDIT_FEATURE } from "@/lib/one-voice/protocol";
import {
  VOICE_UNAVAILABLE_MESSAGE,
  canAutoReconnect,
  hasOpenPendingAction,
  isStaleNavigation,
  localCloseReason,
} from "@/lib/one-voice/session-reducer";
import {
  dispatchServerFrame,
  useVoiceSessionState,
  useVoiceSessionStore,
} from "@/lib/one-voice/session-store";
import type {
  NameEditOutcome,
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
  sendPerf(metric: PerfFrame["metric"], durationMs: number, turnId?: string): boolean;
  sendText(text: string, requestId?: string): boolean;
  sendAppContext(context: AppContextInput): void;
  /** Optional so older test doubles keep compiling; the real client has it. */
  mailDeliveryResult?(deliveryRef: string, actionId: string): boolean;
  /** Optional like mailDeliveryResult; sent only to a relay listing `name_edit`. */
  nameEditSubmit?(pendingActionId: string, name: string, operationId: string): boolean;
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
  /** A route switch can reveal an OS-ended track without a visibility event. */
  isTrackLive?(): boolean;
}

export interface VoicePlaybackLike {
  enqueue(pcm16: Uint8Array, turnId: string): boolean;
  flush(): void;
  fenceTurn(turnId: string): void;
  onSpeakingChanged(callback: (speaking: boolean) => void): () => void;
  onPlaybackStarted(callback: (turnId: string) => void): () => void;
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
  /** Monotonic clock for measurement; injectable in focused tests. */
  perfNow?: () => number;
  clientStepTimeoutMs?: number;
  directiveClaimMs?: number;
};

export const ONE_VOICE_LEASE_OWNER = "one-voice-live" as const;
/** Transport acknowledgement bound, not a conversational turn timeout. */
const TYPED_INPUT_ACK_TIMEOUT_MS = 10_000;
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
const PENDING_CARD_MOUNT_RETRIES = 30;
const PENDING_CARD_MOUNT_RETRY_MS = 100;
let providerMountSequence = 0;

function traceVoiceSession(event: string, facts: Record<string, string | number | boolean>): void {
  // No owner, conversation, route, transcript or mail content enters diagnostics.
  console.info("one_voice.session", { event, ...facts });
}

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

function rectanglesOverlap(a: DOMRect, b: Pick<DOMRect, "left" | "top" | "right" | "bottom">): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** A pending receipt is shown only when its exact card is actually on screen. */
function pendingCardIsVisible(pendingActionId: string): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  const panel = document.querySelector<HTMLElement>('[data-testid="one-voice-panel"]');
  const card = [...(panel?.querySelectorAll<HTMLElement>("[data-pending-action-id]") ?? [])]
    .find((element) => element.dataset.pendingActionId === pendingActionId);
  if (!panel?.isConnected || !card?.isConnected) return false;
  if (card.closest('[hidden], [inert], [aria-hidden="true"]')) return false;

  // On mobile web the keyboard hides the entire bottom shell after a fade.
  // Check the class too, so the fade's first frames never certify an unseen card.
  const root = document.documentElement;
  if (card.closest("[data-app-bottom-shell]") && root.classList.contains("kb-open") &&
      (!root.classList.contains("native-keyboard-inset") || root.classList.contains("kb-resizes"))) {
    return false;
  }
  for (let element: HTMLElement | null = card; element; element = element.parentElement) {
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" ||
        style.visibility === "collapse" || style.opacity === "0") return false;
  }

  const cardRect = card.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (cardRect.width <= 0 || cardRect.height <= 0 ||
      panelRect.width <= 0 || panelRect.height <= 0) return false;
  // A long transcript can leave the newest card below the panel's own scroll
  // area. Bring that card into the panel before certifying it as shown.
  if (!rectanglesOverlap(cardRect, panelRect)) {
    const header = panel.querySelector<HTMLElement>('[data-testid="one-voice-panel-header"]');
    const headerHeight = header?.getBoundingClientRect().height ?? 0;
    panel.scrollTop += cardRect.top - panelRect.top - headerHeight;
    return false;
  }
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  return rectanglesOverlap(cardRect, {
    left,
    top,
    right: left + (viewport?.width ?? window.innerWidth),
    bottom: top + (viewport?.height ?? window.innerHeight),
  });
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
  /** What this relay advertised in session.ready; empty until it does. */
  features: Set<string>;
  client: VoiceLiveClientLike;
  capture: VoiceCaptureLike | null;
  captureReady: boolean;
  playback: VoicePlaybackLike;
  speechEndProbe: SpeechEndProbe;
  firstAudioReceivedAt: Map<string, number>;
  measuredAudioTurns: Set<string>;
  audioContext: AudioContext | null;
  lease: VoiceSessionLease | null;
  gate: HalfDuplexGate | null;
  /**
   * A server-synthesized narration is playing, so the microphone is closed.
   *
   * Independent of `gate`, which is null on every device that reports echo
   * cancellation -- i.e. on the devices most people use. Leaving the mic open
   * through a narration would feed the digest back through
   * `input_audio_transcription` into the operational session's compressed context
   * and its persisted resumption handle, which is the one boundary this whole
   * feature is built around. Frames are dropped while it is set, never buffered,
   * so nothing is replayed when it clears.
   */
  narrating: boolean;
  paused: boolean;
  pauseReason: string | null;
  stoppedLocally: boolean;
  tornDown: boolean;
  closeHandled: boolean;
  unsubscribes: Array<() => void>;
  captureGeneration: number;
  resumePromise: Promise<boolean> | null;
  clientSteps: Map<string, ClientStepEntry>;
  directiveTimers: Set<ReturnType<typeof setTimeout>>;
  pendingShownTimer: ReturnType<typeof setTimeout> | null;
  pendingShownGeneration: number;
  shownPendingActionIds: Set<string>;
  /**
   * The pending action whose tap confirm is in flight: sent (or being
   * prepared) and not yet resolved by the relay. A second Confirm for the
   * same card — a double tap, a re-render that fires twice, a spoken yes on
   * top of a tap — is dropped instead of sending a second `confirm_action`.
   * Cleared when the relay resolves that id, or when the session ends.
   */
  confirmingPendingId: string | null;
  awaitingTypedRequestId: string | null;
  awaitingTypedRequestDeadlineAt: number | null;
  /** Typed name edits awaiting their `name_edit.result`, by operation id. */
  nameEdits: Map<string, NameEditWaiter>;
};

type NameEditWaiter = {
  resolve: (outcome: NameEditOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** How long a typed name edit waits for the relay before the editor may retry. */
export const NAME_EDIT_TIMEOUT_MS = 15_000;
const NAME_EDIT_NOT_SENT = "That didn't go through. Please try again.";

function nameEditRefusal(reasonCode: string, message: string): NameEditOutcome {
  return { status: "rejected", reasonCode, message, pendingActionId: null };
}

type DirectiveContext = {
  pathname: string | null;
  claimMs: number;
  screenTimeoutMs: number;
};

function isStaleDirective(frame: UiDirectiveFrame): boolean {
  if (frame.kind === "navigate" && typeof frame.payload?.call_id === "string") {
    return isStaleNavigation(useVoiceSessionStore.getState().state, frame.payload.call_id, frame.turn_id);
  }
  return isStaleOrigin(frame.turn_id);
}

function reportDirectiveOutcome(session: LiveSession, frame: UiDirectiveFrame, status: "opened" | "failed" | "ignored"): void {
  if (session.tornDown) return;
  const outcome = isStaleDirective(frame) ? "ignored" : status;
  if (frame.kind === "navigate" && typeof frame.payload?.call_id === "string") {
    useVoiceSessionStore.getState().dispatch({
      type: "navigation_settled", callId: frame.payload.call_id, turnId: frame.turn_id, status: outcome,
    });
  }
  session.client.uiSettled(frame.directive_id, outcome);
}

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
  let genericStarted = false;
  let claimTimer: ReturnType<typeof setTimeout> | null = null;
  const clearClaimTimer = () => {
    if (claimTimer !== null) {
      clearTimeout(claimTimer);
      session.directiveTimers.delete(claimTimer);
      claimTimer = null;
    }
  };
  const finish = (status: "opened" | "failed" | "ignored") => {
    if (settled) return;
    settled = true;
    clearClaimTimer();
    reportDirectiveOutcome(session, frame, status);
  };
  const runGeneric = () => {
    if (settled || genericStarted) return;
    if (isStaleDirective(frame)) {
      finish("ignored");
      return;
    }
    genericStarted = true;
    clearClaimTimer();
    void executeDirective(frame.kind, frame.payload || {}, {
      pathname: context.pathname,
    }).then(
      (outcome) => finish(outcome.handled ? outcome.status : "ignored"),
      () => finish("failed"),
    );
  };
  const screenOwned = isScreenOwnedDirective(frame.kind);
  const settle = (status: "opened" | "failed" | "ignored") => {
    if (isStaleDirective(frame)) {
      finish("ignored");
      return;
    }
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
  if (settled || genericStarted) return;
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

function isStaleOrigin(turnId: string | null | undefined): boolean {
  if (!turnId) return false;
  const current = useVoiceSessionStore.getState().state;
  return current.fencedTurnIds.includes(turnId) || Boolean(
    current.activeInputTurnId && current.activeInputTurnId !== turnId
  );
}

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
  useEffect(() => {
    const mount = ++providerMountSequence;
    traceVoiceSession("provider_mount", { mount });
    return () => traceVoiceSession("provider_unmount", { mount });
  }, []);

  const dispatch = useCallback(
    (event: VoiceSessionEvent) =>
      useVoiceSessionStore.getState().dispatch(event),
    [],
  );
  const now = useCallback(() => depsRef.current?.now?.() ?? Date.now(), []);
  const perfNow = useCallback(
    () => depsRef.current?.perfNow?.() ?? performanceNow(),
    [],
  );
  const readState = useCallback(
    (): VoiceSessionState => useVoiceSessionStore.getState().state,
    [],
  );

  // -- app context ------------------------------------------------------------

  // The mail row open on screen. A ref rather than state: nothing renders from
  // it, it rides on every app_context this provider builds (each frame
  // replaces the relay's whole screen context), and changing it resends one.
  const activeMailRef = useRef<{
    ordinal: number;
    offerRevision: number;
    conversationId: string;
  } | null>(null);

  const sendAppContext = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.tornDown) return;
    const activeMail = activeMailRef.current;
    const frame = buildAppContextFrame({
      runtime: runtimeRef.current,
      pathname: pathnameRef.current,
      osLocationPermission: osPermissionRef.current,
      // Only in the conversation whose offer drew the row (a position means
      // nothing against another conversation's list), and only to a relay that
      // accepts the keys: an older one would refuse the whole frame.
      activeMail:
        activeMail &&
        activeMail.conversationId === session.conversationId &&
        session.features.has("active_mail")
          ? activeMail
          : null,
    });
    const { type: _type, ...context } = frame;
    void _type;
    session.client.sendAppContext(context);
  }, []);

  // -- teardown / close --------------------------------------------------------

  const teardown = useCallback((session: LiveSession, reason: string) => {
    if (session.tornDown) return;
    session.tornDown = true;
    session.captureGeneration += 1;
    session.resumePromise = null;
    session.awaitingTypedRequestId = null;
    session.awaitingTypedRequestDeadlineAt = null;
    for (const entry of session.clientSteps.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    session.clientSteps.clear();
    for (const timer of session.directiveTimers) clearTimeout(timer);
    session.directiveTimers.clear();
    if (session.pendingShownTimer !== null) clearTimeout(session.pendingShownTimer);
    session.pendingShownTimer = null;
    // An edit the relay never answered is not an answer; the editor stays open.
    for (const waiter of session.nameEdits.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve(nameEditRefusal("session_ended", NAME_EDIT_NOT_SENT));
    }
    session.nameEdits.clear();
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
    session.speechEndProbe.reset();
    session.firstAudioReceivedAt.clear();
    session.measuredAudioTurns.clear();
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
  /** A resumable close waits here when the app is backgrounded or offline. */
  const pendingNetworkReconnectRef = useRef<string | null>(null);
  const reconnectEpochRef = useRef(0);
  const reconnectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueFailedReconnectRef = useRef<(
    conversationId: string,
    epoch: number,
  ) => void>(() => undefined);

  const handleClose = useCallback(
    (session: LiveSession, info: LiveCloseInfo) => {
      if (session.closeHandled) return;
      session.closeHandled = true;
      traceVoiceSession("socket_close", {
        code: info.code,
        clean: info.clean,
        resumable: info.resumable,
        locallyStopped: session.stoppedLocally,
        paused: session.paused,
        captureLive: session.captureReady && session.capture?.isTrackLive?.() !== false,
      });
      const wasBackgroundPaused =
        session.paused && session.pauseReason === "app_backgrounded";
      teardown(session, `closed:${info.reason}`);
      const before = readState();
      const serverAsked = !session.stoppedLocally && canAutoReconnect(before);
      const networkLost =
        !session.stoppedLocally &&
        info.code === 1006 &&
        info.resumable &&
        !hasOpenPendingAction(before);
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      const active = appInteractionCoordinator.getLifecycleSnapshot().state === "active";
      const eligible =
        latest.current.enabled &&
        latest.current.isVaultUnlocked &&
        Boolean(latest.current.vaultOwnerToken) &&
        Boolean(latest.current.user?.uid) &&
        reconnectsRef.current < MAX_AUTO_RECONNECTS;
      const reconnect =
        (serverAsked || networkLost) &&
        eligible &&
        !offline &&
        active;
      // The reducer reconnects on the reason alone; when this device refuses
      // (owner switched, budget spent) the close is reported as local so the
      // state lands idle instead of waiting on a socket that never opens.
      const reason =
        serverAsked && !reconnect ? localCloseReason(info.reason) : info.reason;
      dispatch({ type: "closed", code: info.code, reason, now: now() });
      if ((serverAsked || networkLost) && eligible && !reconnect && (offline || !active))
        pendingNetworkReconnectRef.current = session.conversationId;
      if (wasBackgroundPaused && info.code === 4009 && !reconnect) {
        // The relay's idle watchdog may expire while a tab is hidden. Keep
        // the conversation id for an explicit retry, and explain why the mic
        // did not restart when the person returned.
        dispatch({
          type: "local_error",
          error: {
            code: "voice_pause_expired",
            message: "One paused while you were away. Tap Try again to resume.",
            recoverable: true,
          },
        });
      }
      if (reconnect) {
        pendingNetworkReconnectRef.current = null;
        reconnectsRef.current += 1;
        const epoch = reconnectEpochRef.current;
        void openSessionRef.current({
          conversationId: session.conversationId,
          isReconnect: true,
        }).then((opened) => {
          if (!opened)
            queueFailedReconnectRef.current(session.conversationId, epoch);
        });
      }
    },
    [dispatch, now, readState, teardown],
  );

  const stopSession = useCallback(
    (reason: string) => {
      // A failed reconnect may wait for the next online event. A person's
      // Stop or an ownership transition must cancel that deferred attempt.
      if (reason !== "start_failed") reconnectEpochRef.current += 1;
      pendingNetworkReconnectRef.current = null;
      if (reconnectRetryTimerRef.current !== null) {
        clearTimeout(reconnectRetryTimerRef.current);
        reconnectRetryTimerRef.current = null;
      }
      if (openingRef.current) {
        openingRef.current.cancelled = true;
        openingRef.current = null;
      }
      const session = sessionRef.current;
      traceVoiceSession("stop", {
        reason,
        hasSession: Boolean(session),
        paused: Boolean(session?.paused),
        captureLive: Boolean(
          session?.captureReady && session.capture?.isTrackLive?.() !== false,
        ),
      });
      if (!session) {
        // Stop must settle immediately even while the lazy client is loading.
        dispatch({ type: "closed", code: 1000, reason: localCloseReason(reason), now: now() });
        return;
      }
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
    [dispatch, handleClose, now],
  );
  const stopRef = useRef(stopSession);
  const pauseRef = useRef<(reason: string) => void>(() => undefined);

  // -- frame side effects --------------------------------------------------------

  const settleDirective = useCallback(
    (session: LiveSession, frame: UiDirectiveFrame) => {
      void loadDirectives().then(
        (directives) => {
          if (sessionRef.current !== session || session.tornDown) return;
          if (isStaleDirective(frame)) {
            reportDirectiveOutcome(session, frame, "ignored");
            return;
          }
          runDirective(session, frame, directives, {
            pathname: pathnameRef.current,
            claimMs: depsRef.current?.directiveClaimMs ?? DIRECTIVE_CLAIM_MS,
            screenTimeoutMs:
              depsRef.current?.clientStepTimeoutMs ?? CLIENT_STEP_TIMEOUT_MS,
          });
        },
        () => {
          reportDirectiveOutcome(session, frame, "failed");
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
      const receivedAt = frame.type === "audio" ||
        (frame.type === "transcript.input" && frame.final)
        ? perfNow()
        : null;
      const before = useVoiceSessionStore.getState().state;
      const origin = "turn_id" in frame && typeof frame.turn_id === "string"
        ? frame.turn_id
        : null;
      if (
        frame.type === "tool.result" && !origin &&
        (before.turnId !== null || before.activeInputTurnId !== null ||
          before.activeResponseTurnId !== null || before.fencedTurnIds.length > 0 ||
          Boolean(frame.pending_action_id))
      ) {
        // A legacy result may settle its exact card, but once this session
        // has seen a question it has no safe screen or answer owner. Initial
        // autonomous results can still reach their screen handlers.
        dispatchServerFrame(frame, now());
        return;
      }
      const staleOrigin = frame.type === "ui_directive" ? isStaleDirective(frame) : isStaleOrigin(origin);
      if (staleOrigin) {
        if (frame.type === "tool.result") {
          // An exact pending card may still settle, but an older result must
          // never replace the current screen's Mail list or trigger a handler.
          dispatchServerFrame(frame, now());
          return;
        }
        if (frame.type === "ui_directive") {
          reportDirectiveOutcome(session, frame, "ignored");
          return;
        }
        if (frame.type === "client_step.request") {
          if (frame.confirmed_pending_action_id) {
            // The relay only marks a step after the person confirmed its exact
            // card. Finish that action even if a newer question is underway;
            // its answer remains fenced from the newer turn.
            requestClientStep(session, frame);
            return;
          }
          session.client.clientStepResult(frame.step_id, "failed", {
            reason: "superseded_turn",
          });
          return;
        }
        if (
          frame.type === "pending_action" ||
          frame.type === "entity_card" ||
          frame.type === "candidate_picker"
        ) return;
      }
      dispatchServerFrame(frame, now());
      const store = useVoiceSessionStore.getState();
      const schedulePendingShown = (id: string) => {
        if (session.pendingShownTimer !== null) clearTimeout(session.pendingShownTimer);
        session.pendingShownTimer = null;
        const generation = ++session.pendingShownGeneration;
        let attempts = 0;
        const checkCard = () => {
          if (sessionRef.current !== session || session.tornDown ||
              generation !== session.pendingShownGeneration ||
              session.shownPendingActionIds.has(id)) return;
          const pending = useVoiceSessionStore.getState().state.pendingAction;
          if (pending?.pending_action_id !== id || pending.resolvedStatus !== null) return;
          if (pendingCardIsVisible(id) && session.client.pendingShown(id)) {
            session.shownPendingActionIds.add(id);
            return;
          }
          if (++attempts >= PENDING_CARD_MOUNT_RETRIES) return;
          session.pendingShownTimer = setTimeout(() => {
            session.pendingShownTimer = null;
            (depsRef.current?.afterPaint ?? defaultAfterPaint)(checkCard);
          }, PENDING_CARD_MOUNT_RETRY_MS);
        };
        (depsRef.current?.afterPaint ?? defaultAfterPaint)(checkCard);
      };
      switch (frame.type) {
        case "session.ready": {
          session.features = new Set(
            Array.isArray(frame.features)
              ? frame.features.filter((item): item is string => typeof item === "string")
              : [],
          );
          sendAppContext();
          // The reducer renders the first re-listed card. If the server never
          // heard it was shown (its pending_action frame was lost to a
          // reconnect), report it once painted so a later "yes" can confirm
          // it instead of being refused as an unseen card.
          const first = frame.pending_actions?.[0];
          if (first && first.status === "pending" && !first.shown_at)
            schedulePendingShown(first.pending_action_id);
          // The relay being ready says nothing about whether getUserMedia has
          // completed. Keep the visible status honest until capture is live.
          if (session.paused || !session.captureReady)
            dispatch({ type: "paused" });
          return;
        }
        case "transcript.input":
          if (frame.final && !staleOrigin) {
            const duration = frame.request_id || session.paused
              ? null
              : session.speechEndProbe.takeDuration(receivedAt ?? perfNow());
            if (duration !== null)
              session.client.sendPerf("endpointing_client", duration, frame.turn_id);
            else session.speechEndProbe.reset();
          }
          if (
            store.state.activeInputTurnId === frame.turn_id &&
            before.activeInputTurnId !== frame.turn_id
          ) {
            // Voice barge-in has already named a new question. Stop queued
            // speech now, without waiting for a provider interrupt marker.
            session.narrating = false;
            session.playback.flush();
            const previousTurn = before.activeResponseTurnId || before.turnId;
            if (previousTurn && previousTurn !== frame.turn_id)
              session.playback.fenceTurn(previousTurn);
          }
          if (
            frame.request_id &&
            frame.request_id === session.awaitingTypedRequestId
          ) {
            session.awaitingTypedRequestId = null;
            session.awaitingTypedRequestDeadlineAt = null;
          }
          return;
        case "audio": {
          if (session.paused) return;
          if (session.awaitingTypedRequestId) {
            if (
              session.awaitingTypedRequestDeadlineAt !== null &&
              now() < session.awaitingTypedRequestDeadlineAt
            )
              return;
            session.awaitingTypedRequestId = null;
            session.awaitingTypedRequestDeadlineAt = null;
          }
          const activeInputTurnId = store.state.activeInputTurnId;
          if (
            frame.origin_turn_id &&
            store.state.fencedTurnIds.includes(frame.origin_turn_id)
          )
            return;
          if (
            frame.origin_turn_id &&
            activeInputTurnId &&
            frame.origin_turn_id !== activeInputTurnId
          )
            return;
          const firstForTurn =
            !session.measuredAudioTurns.has(frame.turn_id) &&
            !session.firstAudioReceivedAt.has(frame.turn_id);
          try {
            const pcm16 = bytesFromBase64(frame.data);
            if (firstForTurn) {
              session.firstAudioReceivedAt.set(frame.turn_id, receivedAt ?? perfNow());
              if (session.firstAudioReceivedAt.size > 32) {
                const oldest = session.firstAudioReceivedAt.keys().next().value;
                if (oldest) session.firstAudioReceivedAt.delete(oldest);
              }
            }
            const queued = session.playback.enqueue(
              pcm16,
              frame.turn_id,
            );
            // A rejected chunk has no playback-stop callback to reopen the mic.
            if (queued && frame.narration === true)
              session.narrating = true;
            if (!queued && firstForTurn)
              session.firstAudioReceivedAt.delete(frame.turn_id);
          } catch {
            if (firstForTurn)
              session.firstAudioReceivedAt.delete(frame.turn_id);
            // A malformed chunk is dropped; the next one schedules normally.
          }
          return;
        }
        case "turn":
          if (frame.state === "interrupted")
            session.playback.fenceTurn(frame.turn_id);
          return;
        case "error":
          if (frame.code === "turn_busy") {
            session.awaitingTypedRequestId = null;
            session.awaitingTypedRequestDeadlineAt = null;
          }
          // A refused confirm remains tappable; its next attempt is not a
          // duplicate of the failed one.
          session.confirmingPendingId = null;
          return;
        case "pending_action": {
          schedulePendingShown(frame.pending_action_id);
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
        case "name_edit.result": {
          // Only the submission this session made; anything else is dropped.
          const waiter = session.nameEdits.get(frame.operation_id);
          if (!waiter) return;
          session.nameEdits.delete(frame.operation_id);
          clearTimeout(waiter.timer);
          waiter.resolve({
            status: frame.status === "accepted" ? "accepted" : "rejected",
            reasonCode: frame.reason_code ?? null,
            message: frame.message ?? null,
            pendingActionId: frame.pending_action_id ?? null,
          });
          return;
        }
        default:
          return;
      }
    },
    [dispatch, now, perfNow, requestClientStep, sendAppContext, settleDirective],
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
      const generation = session.captureGeneration;
      const capture = (
        depsRef.current?.createCapture ?? (() => new LiveAudioCapture())
      )();
      session.capture = capture;
      session.captureReady = false;
      // Begin conservatively before socket/playback can race microphone setup.
      // Keep this same gate when selecting half duplex so no speaking edge or
      // acoustic tail is lost during asynchronous capture startup.
      session.gate ??= new HalfDuplexGate({ now: () => now() });
      session.speechEndProbe.reset();
      capture.setMuted(mutedRef.current);
      let result: CaptureStartResult;
      try {
        result = await capture.start({
          ...(session.audioContext
            ? { audioContext: session.audioContext }
            : {}),
          onFrame: (pcm16) => {
            if (
              sessionRef.current !== session ||
              session.tornDown ||
              session.paused
            )
              return;
            // Dropped, not buffered: a queued frame would replay the narration
            // into the model the moment the gate lifted.
            if (session.narrating) return;
            if (session.gate && !session.gate.allows()) return;
            session.client.sendAudio(pcm16);
          },
          onLevel: (level) => {
            if (
              sessionRef.current === session &&
              !session.tornDown &&
              !session.paused &&
              !mutedRef.current &&
              !session.narrating &&
              (!session.gate || session.gate.allows())
            ) session.speechEndProbe.observe(level, perfNow());
            else session.speechEndProbe.reset();
            dispatchLevel(level);
          },
          onEnded: () => {
            if (
              sessionRef.current !== session ||
              session.capture !== capture ||
              session.captureGeneration !== generation
            )
              return;
            pauseRef.current("microphone_ended");
            dispatch({
              type: "local_error",
              error: {
                code: "mic_ended",
                message: "Microphone stopped. Tap to resume One.",
                recoverable: true,
              },
            });
          },
        });
      } catch (error) {
        if (
          sessionRef.current !== session ||
          session.tornDown ||
          session.capture !== capture ||
          session.captureGeneration !== generation
        ) {
          capture.stop();
          return;
        }
        session.capture = null;
        session.captureReady = false;
        throw error;
      }
      if (
        sessionRef.current !== session ||
        session.tornDown ||
        session.capture !== capture ||
        session.captureGeneration !== generation ||
        appInteractionCoordinator.getLifecycleSnapshot().state !== "active"
      ) {
        capture.stop();
        return;
      }
      if (capture.isTrackLive?.() === false) {
        capture.stop();
        session.capture = null;
        throw new MicCaptureError({
          code: "not_readable",
          message: "Microphone stopped before One could listen.",
        });
      }
      session.captureReady = true;
      const preference = depsRef.current?.halfDuplexPreference?.() ??
        (readSpeakerphoneSafePreference(latest.current.user?.uid)
          ? "speakerphone-safe" : "auto");
      const halfDuplex = decideHalfDuplex({
        echoCancellation: result.echoCancellation,
        forced: preference === "speakerphone-safe",
      });
      if (!halfDuplex) session.gate = null;
      dispatch({ type: "half_duplex", enabled: halfDuplex });
    },
    [dispatch, dispatchLevel, now, perfNow],
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
        features: new Set(),
        client: null as unknown as VoiceLiveClientLike,
        capture: null,
        captureReady: false,
        playback,
        speechEndProbe: new SpeechEndProbe(),
        firstAudioReceivedAt: new Map(),
        measuredAudioTurns: new Set(),
        audioContext,
        lease: null,
        gate: new HalfDuplexGate({ now: () => now() }),
        narrating: false,
        paused: false,
        pauseReason: null,
        stoppedLocally: false,
        tornDown: false,
        closeHandled: false,
        unsubscribes: [],
        captureGeneration: 0,
        resumePromise: null,
        clientSteps: new Map(),
        directiveTimers: new Set(),
        pendingShownTimer: null,
        pendingShownGeneration: 0,
        shownPendingActionIds: new Set(),
        confirmingPendingId: null,
        awaitingTypedRequestId: null,
        awaitingTypedRequestDeadlineAt: null,
        nameEdits: new Map(),
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
        if (openingRef.current === opening) openingRef.current = null;
        teardown(session, "client_unavailable");
        if (opening.cancelled) return false;
        dispatch({
          type: "closed",
          code: 1000,
          reason: localCloseReason("client_unavailable"),
          now: now(),
        });
        dispatch({ type: "local_error", error: toVoiceError(error) });
        return false;
      }
      if (openingRef.current === opening) openingRef.current = null;
      if (opening.cancelled || sessionRef.current) {
        // Release the early AudioContext/player without letting this stale
        // attempt overwrite the state of a newer owner or session.
        session.stoppedLocally = true;
        session.closeHandled = true;
        teardown(session, "cancelled");
        session.client.close(localCloseReason("cancelled"));
        return false;
      }
      sessionRef.current = session;

      session.lease = appInteractionCoordinator.acquireVoiceLease({
        owner: ONE_VOICE_LEASE_OWNER,
        onRevoked: (reason) => {
          if (sessionRef.current !== session) return;
          session.lease = null;
          if (reason === "app_backgrounded") {
            pauseRef.current(reason);
            return;
          }
          stopRef.current(`lease_revoked:${reason}`);
        },
      });
      session.unsubscribes.push(
        playback.onSpeakingChanged((speaking) => {
          if (sessionRef.current !== session) return;
          // The player reports silence after its queue drains. In half duplex,
          // the retained gate adds the acoustic tail before reopening the mic.
          if (!speaking) session.narrating = false;
          session.gate?.onSpeaking(speaking);
          dispatch({ type: "speaking", speaking });
        }),
      );
      session.unsubscribes.push(
        playback.onPlaybackStarted((turnId) => {
          if (sessionRef.current !== session || session.tornDown) return;
          const receivedAt = session.firstAudioReceivedAt.get(turnId);
          if (receivedAt === undefined) return;
          session.firstAudioReceivedAt.delete(turnId);
          session.measuredAudioTurns.add(turnId);
          if (session.measuredAudioTurns.size > 128) {
            const oldest = session.measuredAudioTurns.values().next().value;
            if (oldest) session.measuredAudioTurns.delete(oldest);
          }
          // This is the first observed nonzero WebAudio output tick, within
          // the scheduler's 50 ms cadence; hardware speaker latency is unknown.
          session.client.sendPerf(
            "audio_receive_to_audible",
            Math.round(perfNow() - receivedAt),
            turnId,
          );
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
      if (!session.paused && session.captureReady)
        dispatch({ type: "resumed" });
      return true;
    },
    [dispatch, handleClose, handleFrame, now, perfNow, startCapture, teardown],
  );

  const resumeSession = useCallback(
    async (session: LiveSession): Promise<boolean> => {
      if (session.resumePromise) return session.resumePromise;
      const work = async (): Promise<boolean> => {
        if (
          sessionRef.current !== session ||
          session.tornDown ||
          appInteractionCoordinator.getLifecycleSnapshot().state !== "active"
        )
          return false;
        const generation = session.captureGeneration;
        if (
          session.audioContext &&
          session.audioContext.state === "suspended"
        ) {
          await session.audioContext.resume().catch(() => undefined);
        }
        if (
          sessionRef.current !== session ||
          session.tornDown ||
          session.captureGeneration !== generation ||
          appInteractionCoordinator.getLifecycleSnapshot().state !== "active"
        )
          return false;
        if (!session.lease) {
          session.lease = appInteractionCoordinator.acquireVoiceLease({
            owner: ONE_VOICE_LEASE_OWNER,
            onRevoked: (reason) => {
              if (sessionRef.current !== session) return;
              session.lease = null;
              if (reason === "app_backgrounded") {
                pauseRef.current(reason);
                return;
              }
              stopRef.current(`lease_revoked:${reason}`);
            },
          });
        }
        const lease = session.lease;
        try {
          await startCapture(session);
        } catch (error) {
          if (
            sessionRef.current === session &&
            !session.tornDown &&
            session.captureGeneration === generation
          ) {
            dispatch({ type: "local_error", error: toVoiceError(error) });
            if (session.lease === lease) {
              lease.release("resume_failed");
              session.lease = null;
            }
          }
          return false;
        }
        if (
          sessionRef.current !== session ||
          session.tornDown ||
          session.captureGeneration !== generation ||
          !session.capture ||
          !session.captureReady ||
          session.lease !== lease ||
          !lease.isCurrent() ||
          appInteractionCoordinator.getLifecycleSnapshot().state !== "active"
        )
          return false;
        session.paused = false;
        session.pauseReason = null;
        dispatch({ type: "resumed" });
        sendAppContext();
        return true;
      };
      const promise = work().finally(() => {
        if (session.resumePromise === promise) session.resumePromise = null;
      });
      session.resumePromise = promise;
      return session.resumePromise;
    },
    [dispatch, sendAppContext, startCapture],
  );

  /**
   * Begin (or resume) a session. "unlock_required" means the unlock dialog
   * now owns the gesture; "refused" means nothing started.
   */
  const begin = useCallback(async (): Promise<BeginOutcome> => {
    if (!latest.current.enabled) return "refused";
    if (appInteractionCoordinator.getLifecycleSnapshot().state !== "active")
      return "refused";
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
    reconnectEpochRef.current += 1;
    pendingNetworkReconnectRef.current = null;
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
      if (!session || session.tornDown) return;
      const wasPaused = session.paused;
      session.paused = true;
      session.speechEndProbe.reset();
      session.pauseReason = reason;
      session.captureGeneration += 1;
      // A foreground capture may still be inside getUserMedia or worklet load.
      // Retire that attempt so another foreground event can start a fresh one.
      session.resumePromise = null;
      try {
        session.capture?.stop();
      } catch {
        // ignore
      }
      session.capture = null;
      session.captureReady = false;
      if (wasPaused) return;
      session.narrating = false;
      session.playback.flush();
      session.gate?.reset();
      session.client.cancel({ scope: "turn" });
      dispatch({ type: "paused" });
    },
    [dispatch],
  );
  useEffect(() => {
    stopRef.current = stopSession;
    openSessionRef.current = openSession;
    beginRef.current = begin;
    pauseRef.current = pause;
  }, [begin, openSession, pause, stopSession]);

  useEffect(() => {
    const queueFailedReconnect = (conversationId: string, epoch: number) => {
      if (
        reconnectEpochRef.current !== epoch ||
        sessionRef.current ||
        openingRef.current ||
        pendingNetworkReconnectRef.current ||
        reconnectsRef.current >= MAX_AUTO_RECONNECTS
      ) return;
      pendingNetworkReconnectRef.current = conversationId;
      if (
        navigator.onLine !== false &&
        appInteractionCoordinator.getLifecycleSnapshot().state === "active" &&
        reconnectRetryTimerRef.current === null
      ) {
        reconnectRetryTimerRef.current = setTimeout(() => {
          reconnectRetryTimerRef.current = null;
          reconnectWhenOnline();
        }, 1000 * reconnectsRef.current);
      }
    };
    queueFailedReconnectRef.current = queueFailedReconnect;
    const reconnectWhenOnline = () => {
      const conversationId = pendingNetworkReconnectRef.current;
      if (
        !conversationId ||
        sessionRef.current ||
        openingRef.current ||
        !latest.current.enabled ||
        !latest.current.isVaultUnlocked ||
        !latest.current.vaultOwnerToken ||
        !latest.current.user?.uid ||
        navigator.onLine === false ||
        appInteractionCoordinator.getLifecycleSnapshot().state !== "active" ||
        reconnectsRef.current >= MAX_AUTO_RECONNECTS
      ) return;
      if (reconnectRetryTimerRef.current !== null) {
        clearTimeout(reconnectRetryTimerRef.current);
        reconnectRetryTimerRef.current = null;
      }
      reconnectsRef.current += 1;
      pendingNetworkReconnectRef.current = null;
      const epoch = reconnectEpochRef.current;
      void openSessionRef.current({ conversationId, isReconnect: true }).then((opened) => {
        if (!opened) queueFailedReconnect(conversationId, epoch);
      });
    };
    const lifecycleChanged = () => {
      const lifecycle = appInteractionCoordinator.getLifecycleSnapshot();
      if (lifecycle.state === "background") {
        pauseRef.current("app_backgrounded");
        return;
      }
      const session = sessionRef.current;
      if (session?.paused) void resumeSession(session);
      reconnectWhenOnline();
    };
    window.addEventListener("online", reconnectWhenOnline);
    const unsubscribe =
      appInteractionCoordinator.subscribeLifecycle(lifecycleChanged);
    lifecycleChanged();
    return () => {
      window.removeEventListener("online", reconnectWhenOnline);
      unsubscribe();
      if (reconnectRetryTimerRef.current !== null) {
        clearTimeout(reconnectRetryTimerRef.current);
        reconnectRetryTimerRef.current = null;
      }
      queueFailedReconnectRef.current = () => undefined;
    };
  }, [resumeSession]);

  const submitText = useCallback(
    (session: LiveSession, text: string): boolean => {
      if (session.tornDown || session.paused) return false;
      const requestId = crypto.randomUUID();
      const previousRequestId = session.awaitingTypedRequestId;
      const previousDeadline = session.awaitingTypedRequestDeadlineAt;
      session.awaitingTypedRequestId = requestId;
      session.awaitingTypedRequestDeadlineAt =
        now() + TYPED_INPUT_ACK_TIMEOUT_MS;
      if (!session.client.sendText(text, requestId)) {
        if (session.awaitingTypedRequestId === requestId) {
          session.awaitingTypedRequestId = previousRequestId;
          session.awaitingTypedRequestDeadlineAt = previousDeadline;
        }
        return false;
      }
      session.speechEndProbe.reset();
      session.narrating = false;
      session.playback.flush();
      const turnId = readState().turnId;
      if (turnId) session.playback.fenceTurn(turnId);
      return true;
    },
    [now, readState],
  );

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
          return submitText(session, text);
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
  }, [dispatch, enabled, submitText]);

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
    activeMailRef.current = null;
    stopRef.current("account_changed");
  }, [user?.uid]);
  useEffect(() => () => stopRef.current("unmount"), []);

  // App context follows the route, the OS permission, and screen reports.
  useEffect(() => {
    sendAppContext();
    const session = sessionRef.current;
    if (
      session &&
      !session.paused &&
      session.captureReady &&
      session.capture?.isTrackLive?.() === false &&
      appInteractionCoordinator.getLifecycleSnapshot().state === "active"
    ) {
      pauseRef.current("microphone_ended");
      void resumeSession(session);
    }
  }, [pathname, osPermission, resumeSession, sendAppContext]);
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
      if (muted) sessionRef.current?.speechEndProbe.reset();
      if (muted) dispatchLevel(0);
      dispatch({ type: "muted", muted });
    },
    [dispatch, dispatchLevel],
  );

  const interrupt = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.tornDown) return;
    // Local Stop reaches a narration where barge-in cannot: `fenceTurn` assigns a
    // narration's unseen turn id a HIGHER order than the model turn it followed,
    // so fencing the model's turn never stops it. `flush()` does, and it runs
    // first here. The mic reopens now, because the drain callback that would
    // otherwise clear this is exactly what the flush prevents.
    session.narrating = false;
    session.playback.flush();
    const turnId = readState().turnId;
    if (turnId) session.playback.fenceTurn(turnId);
    session.client.interrupt();
  }, [readState]);

  const sendText = useCallback(
    (text: string) => {
      const session = sessionRef.current;
      if (!session || session.tornDown) return;
      submitText(session, text);
    },
    [submitText],
  );

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

  const openMail = useCallback(
    async (input: {
      ordinal: number;
      offerRevision: number;
      conversationId: string;
    }) => {
      // The token is read from `latest.current` for the same reason start() does:
      // the closure variable is a render-time snapshot, and this runs on a tap.
      const token = latest.current.vaultOwnerToken;
      if (!token) throw new MailOpenError("auth_missing");
      // The conversation comes from the result that drew the row. Reading the
      // live id here would resolve the position against whatever conversation a
      // reconnect has since moved to, and open a different message.
      return openOfferedMail({
        vaultOwnerToken: token,
        conversationId: input.conversationId,
        ordinal: input.ordinal,
        offerRevision: input.offerRevision,
      });
    },
    [],
  );

  const openDraft = useCallback(
    async (input: {
      ordinal: number;
      offerRevision: number;
      conversationId: string;
    }) => {
      // Same reasons as openMail: the token is read at tap time, and the
      // conversation comes from the result that drew the row.
      const token = latest.current.vaultOwnerToken;
      if (!token) throw new MailOpenError("auth_missing");
      return openOfferedDraft({
        vaultOwnerToken: token,
        conversationId: input.conversationId,
        ordinal: input.ordinal,
        offerRevision: input.offerRevision,
      });
    },
    [],
  );

  const setActiveMail = useCallback(
    (hint: { ordinal: number; offerRevision: number; conversationId: string } | null) => {
      const current = activeMailRef.current;
      if (
        hint === current ||
        (hint &&
          current &&
          hint.ordinal === current.ordinal &&
          hint.offerRevision === current.offerRevision &&
          hint.conversationId === current.conversationId)
      ) {
        return;
      }
      activeMailRef.current = hint;
      sendAppContext();
    },
    [sendAppContext],
  );

  const reportMailDelivery = useCallback((deliveryRef: string, actionId: string) => {
    const session = sessionRef.current;
    // A relay that never listed the frame would answer it with a protocol error.
    if (!session || session.tornDown || !session.features.has("mail_delivery")) return;
    session.client.mailDeliveryResult?.(deliveryRef, actionId);
  }, []);

  const submitNameEdit = useCallback(
    (pendingActionId: string, name: string): Promise<NameEditOutcome> => {
      const session = sessionRef.current;
      // A relay that never listed the frame would answer it with a protocol error.
      if (!session || session.tornDown || !session.features.has(NAME_EDIT_FEATURE))
        return Promise.resolve(nameEditRefusal("unavailable", NAME_EDIT_NOT_SENT));
      const operationId = crypto.randomUUID();
      if (!session.client.nameEditSubmit?.(pendingActionId, name, operationId))
        return Promise.resolve(nameEditRefusal("not_sent", NAME_EDIT_NOT_SENT));
      return new Promise<NameEditOutcome>((resolve) => {
        const timer = setTimeout(() => {
          session.nameEdits.delete(operationId);
          resolve(nameEditRefusal("timeout", NAME_EDIT_NOT_SENT));
        }, NAME_EDIT_TIMEOUT_MS);
        session.nameEdits.set(operationId, { resolve, timer });
      });
    },
    [],
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

  const clearView = useCallback(() => {
    // Nothing is sent and no session lifecycle is touched: the relay, the mic
    // and One's own conversation context carry on unchanged.
    dispatch({ type: "clear_view" });
  }, [dispatch]);

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
      openMail,
      openDraft,
      cancelPending,
      chooseCandidate,
      clearView,
      reportClientStep,
      setActiveMail,
      reportMailDelivery,
      submitNameEdit,
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
      openMail,
      openDraft,
      cancelPending,
      chooseCandidate,
      clearView,
      reportClientStep,
      setActiveMail,
      reportMailDelivery,
      submitNameEdit,
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

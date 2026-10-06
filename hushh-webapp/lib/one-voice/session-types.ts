/**
 * Client-side session model for One Live Voice.
 *
 * The reducer state is derived ONLY from server frames (plus local audio
 * facts such as "speaking"). Transcript text never sets UI state; success
 * chips come from `tool.result ok:true` / `pending_action.resolved executed`.
 */

import type { OpenedDraft, OpenedMailMessage } from "@/lib/one-voice/mail-open";
import type {
  CandidatePublic,
  EntityCardPayload,
  PendingActionPublic,
  ServerFrame,
  ToolResultPublic,
  VoiceState,
} from "@/lib/one-voice/protocol";

export type VoicePhase =
  | "idle"
  | "connecting"
  | "listening"
  | "understanding"
  | "asking"
  | "confirming"
  | "executing"
  | "complete"
  | "error"
  | "paused";

export type TranscriptItem = {
  id: string;
  role: "you" | "one";
  text: string;
  final: boolean;
  turnId: string;
  /** Relay-owned segment of a contracted row (row id `role:segmentId`). */
  segmentId?: string;
  /** Highest frame seq applied to a contracted row; older frames are ignored. */
  lastSeq?: number;
};

export type ToolTimelineItem = {
  callId: string | null;
  turnId?: string | null;
  tool: string;
  argsSummary: string;
  result?: ToolResultPublic;
  ok?: boolean;
  navigationOutcome?: "opened" | "failed" | "ignored";
  navigationSuperseded?: boolean;
};

export type PendingActionView = PendingActionPublic & {
  riskLevel: "low" | "medium" | "high";
  requiresTap: boolean;
  entities: EntityCardPayload[];
  receiptToken: string | null;
  /** Transient display association only; never action or send authority. */
  offeredResult?: ToolResultPublic;
  resolvedStatus: "executed" | "failed" | "cancelled" | "expired" | "not_pending" | null;
  resolvedResult: ToolResultPublic | null;
};

export type CandidatePickerView = {
  kind: "person" | "circle";
  question: string;
  candidates: CandidatePublic[];
};

export type ClientStepView = {
  stepId: string;
  kind: string;
  payload: Record<string, unknown>;
  timeoutS: number;
};

export type VoiceError = {
  code: string;
  message: string;
  recoverable: boolean;
};

export type VoiceSessionState = {
  phase: VoicePhase;
  serverState: VoiceState | null;
  sessionId: string | null;
  conversationId: string | null;
  model: string | null;
  turnId: string | null;
  /** Most recent accepted input, separate from provider playback turn IDs. */
  activeInputTurnId: string | null;
  /** Origin of the most recent response, including narration with its own playback ID. */
  activeResponseTurnId: string | null;
  /** Prior input/response origins whose late frames must not replace a newer answer. */
  fencedTurnIds: string[];
  speaking: boolean;
  muted: boolean;
  degraded: boolean;
  halfDuplex: boolean;
  level: number;
  transcript: TranscriptItem[];
  /**
   * Monotonic counter behind transcript row ids. It only grows within a
   * conversation, so ids stay unique after the row cap or a view clear.
   */
  transcriptSeq: number;
  /**
   * Turns that were still streaming when the view was cleared. Their later
   * chunks and their finalization stay out of the displayed history; a turn
   * drops off this list once it ends, so it cannot grow without bound.
   */
  clearedTurnIds: string[];
  /** The displayed history is empty because the person cleared it. */
  historyCleared: boolean;
  entities: EntityCardPayload[];
  candidatePicker: CandidatePickerView | null;
  pendingAction: PendingActionView | null;
  clientStep: ClientStepView | null;
  toolTimeline: ToolTimelineItem[];
  lastResult: ToolResultPublic | null;
  error: VoiceError | null;
  idleTimeoutMs: number | null;
  idleDeadlineAt: number | null;
  reconnectReason: "go_away" | "max_duration" | null;
  /**
   * What the connected relay advertised in session.ready (`features`). Empty
   * until it does and after the socket closes, so a surface never offers a
   * frame an older relay would refuse.
   */
  relayFeatures: string[];
};

/** The relay's answer to a typed name edit, or the client's own refusal. */
export type NameEditOutcome = {
  status: "accepted" | "rejected";
  reasonCode: string | null;
  message: string | null;
  /** The new card on `accepted`. */
  pendingActionId: string | null;
};

export type VoiceSessionEvent =
  | { type: "navigation_settled"; callId: string; turnId?: string | null; status: "opened" | "failed" | "ignored" }
  | { type: "server"; frame: ServerFrame; now: number }
  | { type: "connecting"; conversationId: string }
  | { type: "closed"; code: number; reason: string; now: number }
  | { type: "speaking"; speaking: boolean }
  | { type: "muted"; muted: boolean }
  | { type: "degraded"; degraded: boolean }
  | { type: "half_duplex"; enabled: boolean }
  | { type: "level"; level: number }
  | { type: "paused" }
  | { type: "resumed" }
  | { type: "local_error"; error: VoiceError }
  | { type: "dismiss_candidates" }
  | { type: "client_step_done"; stepId: string }
  // Presentation only: drops the displayed history. It ends nothing, deletes
  // nothing on the server, and One keeps its own conversation context.
  | { type: "clear_view" }
  | { type: "reset" };

export const INITIAL_VOICE_SESSION_STATE: VoiceSessionState = {
  phase: "idle",
  serverState: null,
  sessionId: null,
  conversationId: null,
  model: null,
  turnId: null,
  activeInputTurnId: null,
  activeResponseTurnId: null,
  fencedTurnIds: [],
  speaking: false,
  muted: false,
  degraded: false,
  halfDuplex: false,
  level: 0,
  transcript: [],
  transcriptSeq: 0,
  clearedTurnIds: [],
  historyCleared: false,
  entities: [],
  candidatePicker: null,
  pendingAction: null,
  clientStep: null,
  toolTimeline: [],
  lastResult: null,
  error: null,
  idleTimeoutMs: null,
  idleDeadlineAt: null,
  reconnectReason: null,
  relayFeatures: [],
};

/** What the provider exposes to the control, the panel, and the screens. */
export type VoiceSessionController = {
  enabled: boolean;
  state: VoiceSessionState;
  /** Begin a session (mints a ticket, opens the socket, starts the mic). */
  start: (options?: { source?: string; requestId?: string }) => Promise<void>;
  /** End the session and release the mic. */
  stop: (reason?: string) => void;
  setMuted: (muted: boolean) => void;
  /** Barge in: stop playback and tell the server. */
  interrupt: () => void;
  /** Type instead of speaking (accessibility + tests). */
  sendText: (text: string) => void;
  /** Tap-confirm the pending action (sends the receipt). */
  confirmPending: (options?: { consentVersion?: string | null }) => Promise<void>;
  /**
   * Open the original message at a position One offered.
   *
   * Goes straight to the resolver over HTTP, not through the model: the model is
   * given counts and never learns which message was second, so it could not name
   * one. `offerRevision` and the conversation come from the result that drew the
   * row, never from ambient state, so a replaced list is refused instead of
   * reinterpreted. Throws `MailOpenError` with a typed reason.
   */
  openMail: (input: {
    ordinal: number;
    offerRevision: number;
    conversationId: string;
  }) => Promise<OpenedMailMessage>;
  /**
   * Open the owner's draft at a position in a drafts list One offered. The same
   * binding and resolver shape as `openMail`, against `/draft/open`; optional so
   * a surface without drafts keeps its rows plain.
   */
  openDraft?: (input: {
    ordinal: number;
    offerRevision: number;
    conversationId: string;
  }) => Promise<OpenedDraft>;
  cancelPending: () => void;
  chooseCandidate: (id: string | null) => void;
  /**
   * Drop the displayed history. Presentation only: it sends nothing, ends
   * nothing, and deletes nothing on the server or in One's context.
   */
  clearView: () => void;
  /** Report a client step outcome (publish, permission, share sheet). */
  reportClientStep: (stepId: string, status: "ok" | "failed", payload?: Record<string, unknown>) => void;
  /**
   * Tell the relay which mail row is open on screen, or that none is. The
   * position and the offer revision only, never a message id: it is a hint for
   * "reply to this" that the relay honors only while that offer is current.
   * It rides on every app_context until cleared.
   */
  setActiveMail?: (
    hint: { ordinal: number; offerRevision: number; conversationId: string } | null,
  ) => void;
  /**
   * A review card's Send finished: its delivery ref and the send action it
   * used. Carries no outcome on purpose; the relay re-reads the send action.
   */
  reportMailDelivery?: (deliveryRef: string, actionId: string) => void;
  /**
   * Replace an open create_circle card with a name the person typed. Resolves
   * with the relay's `name_edit.result` for this submission, or a local
   * refusal when no relay that accepts it is live. Never routes through the
   * model.
   */
  submitNameEdit?: (pendingActionId: string, name: string) => Promise<NameEditOutcome>;
};

/** Screen hooks subscribe to tool results and directives by tool name/kind. */
export type VoiceToolEffectHandlers = {
  onToolResult?: (tool: string, result: ToolResultPublic) => void;
  onPendingResolved?: (pendingActionId: string, status: string, result: ToolResultPublic | null) => void;
  onDirective?: (
    directiveId: string,
    kind: string,
    payload: Record<string, unknown>,
    settle: (status: "opened" | "failed" | "ignored") => void,
  ) => void;
  onClientStep?: (
    step: ClientStepView,
    report: (status: "ok" | "failed", payload?: Record<string, unknown>) => void,
  ) => void;
};

/**
 * Client-side session model for One Live Voice.
 *
 * The reducer state is derived ONLY from server frames (plus local audio
 * facts such as "speaking"). Transcript text never sets UI state; success
 * chips come from `tool.result ok:true` / `pending_action.resolved executed`.
 */

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
};

export type ToolTimelineItem = {
  callId: string | null;
  tool: string;
  argsSummary: string;
  result?: ToolResultPublic;
  ok?: boolean;
};

export type PendingActionView = PendingActionPublic & {
  riskLevel: "low" | "medium" | "high";
  requiresTap: boolean;
  entities: EntityCardPayload[];
  receiptToken: string | null;
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
  speaking: boolean;
  muted: boolean;
  degraded: boolean;
  halfDuplex: boolean;
  level: number;
  transcript: TranscriptItem[];
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
};

export type VoiceSessionEvent =
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
  speaking: false,
  muted: false,
  degraded: false,
  halfDuplex: false,
  level: 0,
  transcript: [],
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
  cancelPending: () => void;
  chooseCandidate: (id: string | null) => void;
  /**
   * Drop the displayed history. Presentation only: it sends nothing, ends
   * nothing, and deletes nothing on the server or in One's context.
   */
  clearView: () => void;
  /** Report a client step outcome (publish, permission, share sheet). */
  reportClientStep: (stepId: string, status: "ok" | "failed", payload?: Record<string, unknown>) => void;
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

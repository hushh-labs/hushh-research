/**
 * Pure reducer: (VoiceSessionState, VoiceSessionEvent) -> VoiceSessionState.
 *
 * Every server frame and every local event lands here. The reducer is the only
 * place UI state is derived from the wire, and it derives it ONLY from typed
 * frames: `transcript.*` frames append text and nothing else; a success-looking
 * phase or receipt comes from `tool.result ok:true` or
 * `pending_action.resolved status:"executed"`, never from what was said.
 *
 * Invariants the tests pin:
 *   - no path sets a success-looking phase from `transcript.*`
 *   - `state: complete` without a `tool.result` yields no success receipt
 *   - a resolved/cancelled pending action clears its receipt token
 *   - the newest pending action is the one on screen; a stale resolution for a
 *     different id never clears the card that is showing
 */

import { CLOSE_CODES, NOT_SUCCESS_STATUSES } from "@/lib/one-voice/protocol";
import type {
  EntityCardPayload,
  PendingActionPublic,
  ServerFrame,
  ToolResultPublic,
  VoiceState,
} from "@/lib/one-voice/protocol";
import {
  INITIAL_VOICE_SESSION_STATE,
  type PendingActionView,
  type ToolTimelineItem,
  type TranscriptItem,
  type VoiceError,
  type VoicePhase,
  type VoiceSessionEvent,
  type VoiceSessionState,
} from "@/lib/one-voice/session-types";

// --- bounds -------------------------------------------------------------------

const MAX_TRANSCRIPT_ITEMS = 200;
const MAX_TIMELINE_ITEMS = 50;
const MAX_ENTITIES = 20;
const MAX_CANDIDATES = 5;
const MAX_ARGS_SUMMARY_CHARS = 160;

/**
 * Statuses that are truthful outcomes but not achievements: an empty read, a
 * "nothing changed" answer, a partial delivery, or a clarifying question. They
 * are `ok` on the wire (the model must narrate them) but they never earn a
 * success chip. Kept client-side on top of the shared NOT_SUCCESS set.
 */
const NEUTRAL_STATUSES = new Set<string>([
  "none",
  "empty",
  "multiple",
  "single_likely",
  "low_confidence",
  "unverified",
  "invalid",
  "unavailable",
  "expired",
  "in_progress",
  "sos_partial",
  "sos_not_sent",
  "step_order",
  "recipient_key_missing",
  "recipient_not_ready",
  "os_permission_state_required",
  "sos_active",
]);
const NEUTRAL_PREFIXES = ["no_", "not_", "already_"];

/** True for a status that must not render as success (shared set + neutral). */
export function isNeutralStatus(status: string | null | undefined): boolean {
  const value = String(status || "").trim();
  if (!value) return true;
  if (NEUTRAL_STATUSES.has(value)) return true;
  return NEUTRAL_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** A status that may render as success once the frame also says `ok:true`. */
export function isSuccessStatus(status: string | null | undefined): boolean {
  const value = String(status || "").trim();
  if (!value) return false;
  if (NOT_SUCCESS_STATUSES.has(value)) return false;
  return !isNeutralStatus(value);
}

export type ToolResultTone = "success" | "neutral" | "failure";

/** How a tool result should read on screen; success needs both `ok` and a success status. */
export function toolResultTone(
  status: string | null | undefined,
  ok: boolean | undefined,
): ToolResultTone {
  const value = String(status || "").trim();
  if (
    !ok ||
    !value ||
    NOT_SUCCESS_STATUSES.has(value) ||
    value === "rejected" ||
    value === "failed"
  )
    return "failure";
  return isSuccessStatus(value) ? "success" : "neutral";
}

export type SuccessReceipt = {
  source: "tool.result" | "pending_action.resolved";
  tool: string;
  status: string;
  result: ToolResultPublic | null;
};

/**
 * The only thing a "Done" chip may be rendered from. Derived from the last
 * `tool.result ok:true` with a success status or from the pending action that
 * resolved `executed`; never from the phase, the server state, or a transcript.
 */
export function selectSuccessReceipt(
  state: VoiceSessionState,
): SuccessReceipt | null {
  const pending = state.pendingAction;
  if (pending && pending.resolvedStatus === "executed") {
    // A resolution without a public result still executed; the wire status wins when present.
    const status = String(pending.resolvedResult?.status || "executed");
    if (isSuccessStatus(status)) {
      return {
        source: "pending_action.resolved",
        tool: pending.tool,
        status,
        result: pending.resolvedResult,
      };
    }
  }
  const last = state.lastResult;
  if (!last) return null;
  const item = findLastTimelineItemWithResult(state.toolTimeline, last);
  const ok = item ? item.ok === true : false;
  const status = String(last.status || "");
  if (!ok || !isSuccessStatus(status)) return null;
  return {
    source: "tool.result",
    tool: item?.tool || "",
    status,
    result: last,
  };
}

function findLastTimelineItemWithResult(
  timeline: ToolTimelineItem[],
  result: ToolResultPublic,
): ToolTimelineItem | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.result === result) return timeline[index] ?? null;
  }
  return null;
}

// --- helpers ------------------------------------------------------------------

const RECOVERABLE_CLOSE_CODES = new Set<number>([
  CLOSE_CODES.ended,
  CLOSE_CODES.idle,
]);

export const VOICE_UNAVAILABLE_MESSAGE =
  "Voice is unavailable right now. You can keep typing to One.";

/** Map a socket close code to the error the control shows (null for a clean end). */
export function voiceErrorForClose(
  code: number,
  reason: string,
): VoiceError | null {
  switch (code) {
    case CLOSE_CODES.ended:
    case CLOSE_CODES.idle:
      return null;
    case CLOSE_CODES.providerUnavailable:
      return {
        code: "voice_unavailable",
        message: VOICE_UNAVAILABLE_MESSAGE,
        recoverable: false,
      };
    case CLOSE_CODES.disabled:
      return {
        code: "disabled",
        message: "Voice is not available.",
        recoverable: false,
      };
    case CLOSE_CODES.auth:
    case CLOSE_CODES.ticket:
      return {
        code: "auth",
        message: "Unlock again to talk to One.",
        recoverable: false,
      };
    case CLOSE_CODES.capacity:
      return {
        code: "capacity",
        message: "Voice is busy right now. Try again in a moment.",
        recoverable: false,
      };
    case CLOSE_CODES.replaced:
      return {
        code: "replaced",
        message: "Voice moved to another device or tab.",
        recoverable: false,
      };
    case CLOSE_CODES.maxDuration:
      return {
        code: "max_duration",
        message: "This session reached its time limit.",
        recoverable: false,
      };
    case CLOSE_CODES.protocol:
      return {
        code: "protocol",
        message: VOICE_UNAVAILABLE_MESSAGE,
        recoverable: false,
      };
    default:
      return {
        code: reason
          ? `closed_${code}:${reason.slice(0, 40)}`
          : `closed_${code}`,
        message: "Voice ended unexpectedly.",
        recoverable: false,
      };
  }
}

/** A pending action is open while it is on screen and has not resolved. */
export function hasOpenPendingAction(state: VoiceSessionState): boolean {
  return Boolean(
    state.pendingAction && state.pendingAction.resolvedStatus === null,
  );
}

/**
 * Whether the provider may reopen the socket on its own after a close: only
 * when the server asked for it (`session.reconnect_required`) and no
 * confirmation card is waiting on the person. A card mid-flight never survives
 * a silent reconnect; the person taps again instead.
 */
export function canAutoReconnect(state: VoiceSessionState): boolean {
  return state.reconnectReason !== null && !hasOpenPendingAction(state);
}

/**
 * Close reasons the device chose itself (a tap on Stop, backgrounding, a lost
 * lease) carry this prefix so a `closed` event can tell a local end from the
 * server's `go_away`, which is the only close that may reconnect.
 */
export const LOCAL_CLOSE_REASON_PREFIX = "local:";

export function localCloseReason(reason: string): string {
  const clean = String(reason || "ended").trim() || "ended";
  return clean.startsWith(LOCAL_CLOSE_REASON_PREFIX)
    ? clean
    : `${LOCAL_CLOSE_REASON_PREFIX}${clean}`;
}

export function isLocalCloseReason(reason: string | null | undefined): boolean {
  return (
    typeof reason === "string" && reason.startsWith(LOCAL_CLOSE_REASON_PREFIX)
  );
}

/** Error frames the server sends while the session keeps running. */
const INFORMATIONAL_ERROR_CODES = new Set<string>([
  "protocol",
  "firebase_proof_required",
  // The tap's proof failed verification (expired, revoked, other account);
  // the card stays pending and a fresh tap can still complete it.
  "firebase_proof_invalid",
]);

function summarizeArgs(
  args: Record<string, unknown> | null | undefined,
): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) continue;
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : Array.isArray(value)
            ? `${value.length} items`
            : "…";
    parts.push(`${key}: ${text}`);
  }
  const joined = parts.join(", ");
  return joined.length > MAX_ARGS_SUMMARY_CHARS
    ? `${joined.slice(0, MAX_ARGS_SUMMARY_CHARS - 1)}…`
    : joined;
}

function entityId(entity: EntityCardPayload): string | null {
  if (entity.kind === "circle")
    return entity.circle_id ? `circle:${entity.circle_id}` : null;
  return entity.user_id ? `person:${entity.user_id}` : null;
}

function upsertEntity(
  entities: EntityCardPayload[],
  incoming: EntityCardPayload,
): EntityCardPayload[] {
  const id = entityId(incoming);
  const rest = id
    ? entities.filter((entity) => entityId(entity) !== id)
    : entities;
  return [incoming, ...rest].slice(0, MAX_ENTITIES);
}

function pendingViewFromPublic(row: PendingActionPublic): PendingActionView {
  return {
    ...row,
    riskLevel: row.tier === "tap" ? "high" : "medium",
    requiresTap: row.tier === "tap",
    entities: [],
    receiptToken: null,
    resolvedStatus: null,
    resolvedResult: null,
  };
}

function mapServerStateToPhase(
  current: VoicePhase,
  state: VoiceState,
): VoicePhase {
  if (state === "listening") {
    // A paused or errored session stays where the client put it; the server
    // saying "listening" describes the relay, not this device's microphone.
    if (current === "paused" || current === "error") return current;
    return "listening";
  }
  return state;
}

function mergeTranscript(
  transcript: TranscriptItem[],
  role: TranscriptItem["role"],
  turnId: string,
  text: string,
  final: boolean,
): TranscriptItem[] {
  const index = findLastIndex(
    transcript,
    (item) => item.turnId === turnId && item.role === role && !item.final,
  );
  if (index === -1) {
    const item: TranscriptItem = {
      id: `${role}:${turnId}:${transcript.length}`,
      role,
      text,
      final,
      turnId,
    };
    return [...transcript, item].slice(-MAX_TRANSCRIPT_ITEMS);
  }
  const existing = transcript[index]!;
  // Cumulative transcripts replace; incremental ones append.
  const merged =
    !existing.text ||
    (text.length >= existing.text.length && text.startsWith(existing.text))
      ? text
      : `${existing.text}${text}`;
  const next = transcript.slice();
  next[index] = { ...existing, text: merged, final };
  return next;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function fenceTurnTranscript(
  transcript: TranscriptItem[],
  turnId: string,
): TranscriptItem[] {
  let changed = false;
  const next = transcript.map((item) => {
    if (item.turnId === turnId && item.role === "one" && !item.final) {
      changed = true;
      return { ...item, final: true };
    }
    return item;
  });
  return changed ? next : transcript;
}

// --- server frames ------------------------------------------------------------

function reduceServerFrame(
  state: VoiceSessionState,
  frame: ServerFrame,
  now: number,
): VoiceSessionState {
  switch (frame.type) {
    case "session.ready": {
      const first = frame.pending_actions?.[0];
      return {
        ...state,
        // An open card the server re-lists is still waiting on the person.
        phase: first ? "confirming" : "listening",
        serverState: null,
        sessionId: frame.session_id,
        conversationId: frame.conversation_id,
        model: frame.model,
        idleTimeoutMs: frame.idle_timeout_ms,
        idleDeadlineAt: null,
        reconnectReason: null,
        error: null,
        // The server lists what is still open. A card that already resolved on
        // this device keeps its receipt chip; an unresolved one the server no
        // longer knows about is stale and goes away.
        pendingAction: first
          ? state.pendingAction &&
            state.pendingAction.pending_action_id === first.pending_action_id
            ? {
                ...state.pendingAction,
                ...first,
                resolvedStatus: null,
                resolvedResult: null,
              }
            : pendingViewFromPublic(first)
          : state.pendingAction && state.pendingAction.resolvedStatus !== null
            ? state.pendingAction
            : null,
        clientStep: null,
      };
    }
    case "audio":
      return { ...state, turnId: frame.turn_id, idleDeadlineAt: null };
    case "transcript.input":
    case "transcript.output": {
      const role: TranscriptItem["role"] =
        frame.type === "transcript.input" ? "you" : "one";
      return {
        ...state,
        turnId: frame.turn_id,
        idleDeadlineAt: null,
        transcript: mergeTranscript(
          state.transcript,
          role,
          frame.turn_id,
          frame.text,
          frame.final,
        ),
      };
    }
    case "turn": {
      const transcript =
        frame.state === "interrupted" || frame.state === "model_end"
          ? fenceTurnTranscript(state.transcript, frame.turn_id)
          : state.transcript;
      return {
        ...state,
        turnId: frame.turn_id,
        transcript,
        idleDeadlineAt: null,
      };
    }
    case "state": {
      const phase = mapServerStateToPhase(state.phase, frame.state);
      return {
        ...state,
        serverState: frame.state,
        phase,
        turnId: frame.turn_id ?? state.turnId,
        idleDeadlineAt:
          frame.state === "complete" && state.idleTimeoutMs
            ? now + state.idleTimeoutMs
            : null,
      };
    }
    case "tool.started": {
      const item: ToolTimelineItem = {
        callId: frame.call_id || null,
        tool: frame.tool,
        argsSummary: summarizeArgs(frame.args_public),
      };
      return {
        ...state,
        idleDeadlineAt: null,
        toolTimeline: [...state.toolTimeline, item].slice(-MAX_TIMELINE_ITEMS),
      };
    }
    case "tool.result": {
      const ok = frame.ok === true;
      const result = frame.result_public;
      // A device-settled result reuses the originating call id; it replaces
      // the interim `location_updates_pending` entry rather than adding one.
      const index = frame.call_id
        ? findLastIndex(
            state.toolTimeline,
            (item) =>
              item.callId === frame.call_id &&
              (!item.result ||
                item.result.status === "location_updates_pending"),
          )
        : -1;
      let timeline: ToolTimelineItem[];
      if (index === -1) {
        timeline = [
          ...state.toolTimeline,
          {
            callId: frame.call_id,
            tool: frame.tool,
            argsSummary: "",
            result,
            ok,
          },
        ].slice(-MAX_TIMELINE_ITEMS);
      } else {
        timeline = state.toolTimeline.slice();
        timeline[index] = { ...timeline[index]!, result, ok };
      }
      return {
        ...state,
        idleDeadlineAt: null,
        toolTimeline: timeline,
        lastResult: result,
      };
    }
    case "pending_action": {
      const {
        type: _type,
        risk_level,
        requires_tap,
        entities,
        receipt_token,
        ...row
      } = frame;
      void _type;
      const pending: PendingActionView = {
        ...row,
        riskLevel: risk_level,
        requiresTap: requires_tap === true || row.tier === "tap",
        entities: Array.isArray(entities)
          ? entities.slice(0, MAX_ENTITIES)
          : [],
        receiptToken: receipt_token || null,
        resolvedStatus: null,
        resolvedResult: null,
      };
      return {
        ...state,
        phase: "confirming",
        idleDeadlineAt: null,
        pendingAction: pending,
        candidatePicker: null,
      };
    }
    case "pending_action.resolved": {
      const current = state.pendingAction;
      const matches = Boolean(
        current && current.pending_action_id === frame.pending_action_id,
      );
      if (!matches) {
        // A resolution for an action that is not on screen (an older one, or one
        // this device never showed). The card that IS showing keeps its state.
        return { ...state, idleDeadlineAt: null };
      }
      const executed = frame.status === "executed";
      const rowStatus: PendingActionPublic["status"] =
        frame.status === "not_pending" ? current!.status : frame.status;
      return {
        ...state,
        idleDeadlineAt: null,
        phase: executed
          ? "complete"
          : state.phase === "paused" || state.phase === "error"
            ? state.phase
            : "listening",
        pendingAction: {
          ...current!,
          status: rowStatus,
          result: frame.result_public,
          receiptToken: null,
          resolvedStatus: frame.status,
          resolvedResult: frame.result_public,
        },
      };
    }
    case "entity_card": {
      const { type: _type, ...payload } = frame;
      void _type;
      return {
        ...state,
        idleDeadlineAt: null,
        entities: upsertEntity(state.entities, payload),
      };
    }
    case "candidate_picker":
      return {
        ...state,
        idleDeadlineAt: null,
        candidatePicker: {
          kind: frame.kind,
          question: frame.question,
          candidates: (frame.candidates || []).slice(0, MAX_CANDIDATES),
        },
      };
    case "ui_directive":
      // Directives are side effects the provider runs; the reducer only notes activity.
      return state.idleDeadlineAt === null
        ? state
        : { ...state, idleDeadlineAt: null };
    case "client_step.request":
      return {
        ...state,
        idleDeadlineAt: null,
        clientStep: {
          stepId: frame.step_id,
          kind: frame.kind,
          payload: frame.payload || {},
          timeoutS: frame.timeout_s,
        },
      };
    case "session.reconnect_required":
      return { ...state, reconnectReason: frame.reason };
    case "error": {
      const error: VoiceError = {
        code: frame.code,
        message:
          frame.code === "voice_unavailable" ||
          frame.code === "ONE_VOICE_LIVE_DISABLED"
            ? VOICE_UNAVAILABLE_MESSAGE
            : frame.message,
        recoverable: INFORMATIONAL_ERROR_CODES.has(frame.code),
      };
      if (INFORMATIONAL_ERROR_CODES.has(frame.code)) {
        // The relay keeps running after these; surface the message, keep the phase.
        return { ...state, error };
      }
      return {
        ...state,
        error,
        phase: "error",
        speaking: false,
        idleDeadlineAt: null,
      };
    }
    case "pong":
      return state;
    default:
      return state;
  }
}

// --- reducer ------------------------------------------------------------------

export function reduceVoiceSession(
  state: VoiceSessionState,
  event: VoiceSessionEvent,
): VoiceSessionState {
  switch (event.type) {
    case "reset":
      return INITIAL_VOICE_SESSION_STATE;
    case "connecting": {
      const sameConversation = state.conversationId === event.conversationId;
      if (sameConversation) {
        return {
          ...state,
          phase: "connecting",
          serverState: null,
          speaking: false,
          level: 0,
          error: null,
          reconnectReason: null,
          idleDeadlineAt: null,
          clientStep: null,
        };
      }
      return {
        ...INITIAL_VOICE_SESSION_STATE,
        phase: "connecting",
        conversationId: event.conversationId,
        muted: state.muted,
        halfDuplex: state.halfDuplex,
        degraded: state.degraded,
      };
    }
    case "server":
      return reduceServerFrame(state, event.frame, event.now);
    case "closed": {
      const reconnecting =
        canAutoReconnect(state) && !isLocalCloseReason(event.reason);
      const error = reconnecting
        ? null
        : RECOVERABLE_CLOSE_CODES.has(event.code)
          ? state.error && !state.error.recoverable
            ? state.error
            : null
          : (state.error ?? voiceErrorForClose(event.code, event.reason));
      return {
        ...state,
        phase: reconnecting ? "connecting" : "idle",
        serverState: null,
        speaking: false,
        level: 0,
        clientStep: null,
        candidatePicker: null,
        idleDeadlineAt: null,
        // A reconnect that is not happening leaves no stale reason behind.
        reconnectReason: reconnecting ? state.reconnectReason : null,
        error: error
          ? {
              ...error,
              recoverable: RECOVERABLE_CLOSE_CODES.has(event.code)
                ? true
                : error.recoverable,
            }
          : null,
      };
    }
    case "speaking":
      return state.speaking === event.speaking
        ? state
        : { ...state, speaking: event.speaking };
    case "muted":
      return state.muted === event.muted
        ? state
        : { ...state, muted: event.muted };
    case "degraded":
      return state.degraded === event.degraded
        ? state
        : { ...state, degraded: event.degraded };
    case "half_duplex":
      return state.halfDuplex === event.enabled
        ? state
        : { ...state, halfDuplex: event.enabled };
    case "level":
      return state.level === event.level
        ? state
        : { ...state, level: event.level };
    case "paused":
      if (state.phase === "idle") return state;
      return {
        ...state,
        phase: "paused",
        speaking: false,
        level: 0,
        idleDeadlineAt: null,
      };
    case "resumed": {
      if (state.phase !== "paused") return state;
      const phase = state.serverState
        ? mapServerStateToPhase("listening", state.serverState)
        : "listening";
      return { ...state, phase };
    }
    case "local_error":
      return {
        ...state,
        error: event.error,
        phase: state.phase === "idle" ? "idle" : "error",
        speaking: false,
        level: 0,
        idleDeadlineAt: null,
      };
    case "dismiss_candidates":
      return state.candidatePicker
        ? { ...state, candidatePicker: null }
        : state;
    case "client_step_done":
      return state.clientStep && state.clientStep.stepId === event.stepId
        ? { ...state, clientStep: null }
        : state;
    default:
      return state;
  }
}

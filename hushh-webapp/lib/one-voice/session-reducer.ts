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

import {
  CLOSE_CODES,
  NOT_SUCCESS_STATUSES,
  SOS_GRANTS_CREATED,
  SOS_REPORT_TOOL,
  SOS_TRIGGER_TOOL,
} from "@/lib/one-voice/protocol";
import type {
  EntityCardPayload,
  PendingActionPublic,
  ServerFrame,
  ToolResultPublic,
  TranscriptFrame,
  TranscriptKind,
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
// Only turns still streaming at the moment of a clear are suppressed, so this
// list holds at most the handful of turns in flight at once.
const MAX_CLEARED_TURN_IDS = 8;
const MAX_FENCED_TURN_IDS = 16;
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
  "truncated",
  "unverified",
  "invalid",
  "unavailable",
  "expired",
  "in_progress",
  "sos_partial",
  "sos_not_sent",
  // Verification could not read the stored envelopes: not "nothing changed",
  // never "sent".
  "sos_unverified",
  // Some shares ended, some are unresolved and may still be live.
  "sos_partially_stopped",
  // The emergency roster is at its limit; nobody was added.
  "roster_full",
  // add_circle_members: every requested person was refused or already in; no
  // one was added, so the batch must not read as done.
  "none_added",
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

export type ToolResultTone = "success" | "neutral" | "failure" | "pending";

/**
 * Interim statuses that read as "in progress" rather than as a failure: the
 * action ran, a device step is still outstanding, and the settled result is
 * what decides success or failure. Deliberately narrow: `grant_created`,
 * `check_in_created`, `position_publish_pending` and
 * `location_updates_pending` keep their pinned failure tone (their screens
 * render the interim state themselves and the panel hides the card).
 */
const PENDING_STATUSES = new Set<string>([SOS_GRANTS_CREATED, "draft_open_requested"]);

/**
 * Outcomes that are neither done nor failed, whatever the frame's `ok` says.
 * Nothing went wrong, and what the person asked for either did not happen (a
 * cancel that found the email already sent, being sent, or never sent) or
 * cannot be confirmed (Gmail may or may not have sent it). Never "Done".
 */
export const NEUTRAL_OUTCOME_STATUSES = new Set<string>([
  "draft_open_unconfirmed",
  "draft_send_unconfirmed",
  "send_unconfirmed",
  "schedule_unconfirmed",
  "already_sent",
  "already_sending",
  "not_sent",
]);

/** An armed-but-unsent outcome: neither success nor failure yet. */
/**
 * Statuses that ask the surface to do something rather than report an outcome.
 *
 * They carry nothing of their own to show, and the surface they act on is the
 * result already displayed.
 */
export const DISPATCH_ONLY_STATUSES = new Set<string>([
  "mail_open_dispatched",
  "draft_open_dispatched",
]);

/**
 * A mail list the person can still act on by position: rows the server
 * offered under a revision ("open the second one", "reply to it").
 *
 * It keeps the answer slot across a new question until that question produces
 * a result of its own. Clearing it the moment the person spoke took away the
 * very list their words were about, so a spoken open arrived with nothing left
 * on screen to open.
 */
export function keepsAnswerSlotAcrossInput(result: ToolResultPublic | null): boolean {
  return (
    result !== null &&
    typeof result.offer_revision === "number" &&
    Array.isArray(result.items) &&
    result.items.length > 0
  );
}

/**
 * A proposal whose UI is the pending card. It answers nothing yet, so it does
 * not take the answer slot from an offered list: "send the second draft" and
 * "cancel the first one" are approved while the list they name stays on screen.
 */
function isConfirmationHandoff(result: ToolResultPublic): boolean {
  return (
    String(result.status || "").trim() === "confirmation_required" ||
    result.needs === "confirmation"
  );
}

/**
 * A navigation the app was asked to make. It is not a success (it stays in
 * NOT_SUCCESS_STATUSES; the ui_settled outcome decides) and not a failure: it
 * reads as "Opening…". Not pending either -- that would hold the turn open
 * waiting on a device step that never comes.
 */
export const NAVIGATION_DISPATCH_STATUSES = new Set<string>([
  "navigation_dispatched",
]);

export function isPendingStatus(status: string | null | undefined): boolean {
  return PENDING_STATUSES.has(String(status || "").trim());
}

/** How a tool result should read on screen; success needs both `ok` and a success status. */
export function toolResultTone(
  status: string | null | undefined,
  ok: boolean | undefined,
): ToolResultTone {
  const value = String(status || "").trim();
  // An armed Save My Soul is "sending your position", whatever `ok` says: the
  // relay sends it with ok:false because nothing has been delivered yet.
  if (isPendingStatus(value)) return "pending";
  // The review card may already be visible after a lost acknowledgement, a
  // send may or may not have gone out, a cancel may have found nothing left to
  // cancel: avoid both success and failure claims.
  if (NEUTRAL_OUTCOME_STATUSES.has(value)) return "neutral";
  if (NAVIGATION_DISPATCH_STATUSES.has(value)) {
    return ok === false ? "failure" : "neutral";
  }
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
    case 1006:
      return {
        code: "network_lost",
        message: "Connection lost. Tap Try again to resume talking to One.",
        recoverable: true,
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
  "turn_busy",
  "firebase_proof_required",
  // The tap's proof failed verification (expired, revoked, other account);
  // the card stays pending and a fresh tap can still complete it.
  "firebase_proof_invalid",
  // Voice storage could not record a tap or cancel; the relay keeps the
  // session up and the card stays as it was, so the person can try again.
  "storage_unavailable",
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

/**
 * Whitespace-insensitive form of one row's text. Used ONLY to compare a row
 * with an incoming frame of the same role and turn; it never classifies what
 * was said and never matches across turns or roles.
 */
function normalizeTranscriptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type TranscriptMerge = { transcript: TranscriptItem[]; transcriptSeq: number };

/**
 * Renders a transcript frame idempotently per identity (role + turn). A frame
 * carries no chunk id, so the latest row of the same identity decides whether
 * the incoming text restates it (replace), repeats a settled final (no-op),
 * continues it (append to the row) or starts a new line (append a row).
 */
function mergeTranscript(
  transcript: TranscriptItem[],
  transcriptSeq: number,
  role: TranscriptItem["role"],
  turnId: string,
  text: string,
  final: boolean,
): TranscriptMerge {
  const appendRow = (): TranscriptMerge => {
    const item: TranscriptItem = {
      // A monotonic sequence keeps ids unique after the cap drops old rows.
      id: `${role}:${turnId}:${transcriptSeq}`,
      role,
      text,
      final,
      turnId,
    };
    return {
      transcript: [...transcript, item].slice(-MAX_TRANSCRIPT_ITEMS),
      transcriptSeq: transcriptSeq + 1,
    };
  };
  const replaceRow = (index: number, merged: string): TranscriptMerge => {
    const next = transcript.slice();
    next[index] = { ...transcript[index]!, text: merged, final };
    return { transcript: next, transcriptSeq };
  };

  const index = findLastIndex(
    transcript,
    (item) => item.turnId === turnId && item.role === role,
  );
  if (index === -1) return appendRow();
  const existing = transcript[index]!;
  const incoming = normalizeTranscriptText(text);
  const current = normalizeTranscriptText(existing.text);
  const isPrefix = incoming.startsWith(current);
  const longer = incoming.length > current.length;
  // A chunk that begins with whitespace is incremental by its own shape: it
  // continues the row ("H" + " Hussh garage"), so it can never restate it.
  const continues = /^\s/.test(text);
  const restates = !continues && isPrefix;

  if (!existing.final) {
    // A cumulative restatement replaces the row. A chunk equal to the row so
    // far is not strictly longer, so it is incremental and appends ("S","S").
    if (restates && (longer || final)) return replaceRow(index, text);
    return replaceRow(index, `${existing.text}${text}`);
  }
  // The row is settled. Re-sending the same final changes nothing.
  if (final && incoming === current) return { transcript, transcriptSeq };
  if (restates && longer) return replaceRow(index, text);
  // Anything else (e.g. speech after a tool result) is its own line.
  return appendRow();
}

type TranscriptSegment = { segmentId: string; seq: number; kind: TranscriptKind };

/** The relay's segment identity, only when all three fields are well formed. */
function transcriptSegment(frame: TranscriptFrame): TranscriptSegment | null {
  const { segment_id: segmentId, seq, kind } = frame;
  if (typeof segmentId !== "string" || segmentId.length === 0) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  if (kind !== "partial" && kind !== "cumulative" && kind !== "final") return null;
  return { segmentId, seq, kind };
}

/**
 * Applies a contracted frame to its row, keyed by role and the relay's
 * segment id. The relay says how to apply the text, so nothing here reads its
 * shape: a frame at or below the row's last seq (a repeat or a late arrival)
 * and any frame for a frozen row change nothing; partial appends; cumulative
 * replaces; final replaces and freezes.
 */
function mergeContractedTranscript(
  transcript: TranscriptItem[],
  transcriptSeq: number,
  role: TranscriptItem["role"],
  turnId: string,
  text: string,
  segment: TranscriptSegment,
): TranscriptMerge {
  const final = segment.kind === "final";
  const index = findLastIndex(
    transcript,
    (item) => item.role === role && item.segmentId === segment.segmentId,
  );
  if (index === -1) {
    const item: TranscriptItem = {
      id: `${role}:${segment.segmentId}`,
      role,
      text,
      final,
      turnId,
      segmentId: segment.segmentId,
      lastSeq: segment.seq,
    };
    return {
      transcript: [...transcript, item].slice(-MAX_TRANSCRIPT_ITEMS),
      transcriptSeq,
    };
  }
  const existing = transcript[index]!;
  if (existing.final || segment.seq <= (existing.lastSeq ?? 0)) {
    return { transcript, transcriptSeq };
  }
  const next = transcript.slice();
  next[index] = {
    ...existing,
    text: segment.kind === "partial" ? `${existing.text}${text}` : text,
    final,
    lastSeq: segment.seq,
  };
  return { transcript: next, transcriptSeq };
}

/** True when the transcript has anything a person would actually read. */
function hasVisibleTranscript(transcript: TranscriptItem[]): boolean {
  return transcript.some((item) => item.text.trim().length > 0);
}

/**
 * Whether "Clear chat view" has anything to act on. Deliberately narrow: a
 * pending decision, a candidate list, a running step or an unresolved error is
 * live work, not history, so none of them enables the control.
 */
export function panelHasClearableHistory(state: VoiceSessionState): boolean {
  return (
    hasVisibleTranscript(state.transcript) ||
    state.entities.length > 0 ||
    state.lastResult !== null
  );
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

function addFencedTurns(
  previous: string[],
  ...turnIds: (string | null | undefined)[]
): string[] {
  const next = [...previous];
  for (const turnId of turnIds) {
    if (turnId && !next.includes(turnId)) next.push(turnId);
  }
  return next.slice(-MAX_FENCED_TURN_IDS);
}

function isStaleOrigin(state: VoiceSessionState, turnId: string | null | undefined): boolean {
  return Boolean(
    turnId &&
      (state.fencedTurnIds.includes(turnId) ||
        (state.activeInputTurnId && turnId !== state.activeInputTurnId)),
  );
}

/** A completed model turn can still be waiting for its screen to mount. */
export function isStaleNavigation(state: VoiceSessionState, callId: string, turnId?: string | null): boolean {
  const item = state.toolTimeline.findLast((entry) => entry.callId === callId && entry.tool === "open_screen");
  return !item || Boolean(item.navigationSuperseded) || Boolean(turnId && item.turnId !== turnId);
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
        phase: state.phase === "paused" ? "paused" : first ? "confirming" : "listening",
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
        activeInputTurnId: null,
        activeResponseTurnId: null,
        fencedTurnIds: [],
        relayFeatures: Array.isArray(frame.features)
          ? frame.features.filter((item): item is string => typeof item === "string")
          : [],
      };
    }
    case "audio": {
      const origin = frame.origin_turn_id || frame.turn_id;
      if (isStaleOrigin(state, origin)) return state;
      return {
        ...state,
        turnId: frame.turn_id,
        activeResponseTurnId: origin,
        idleDeadlineAt: null,
      };
    }
    case "transcript.input":
    case "transcript.output": {
      const role: TranscriptItem["role"] =
        frame.type === "transcript.input" ? "you" : "one";
      const newInput =
        role === "you" &&
        frame.turn_id !== state.activeInputTurnId &&
        frame.turn_id !== state.activeResponseTurnId &&
        !state.fencedTurnIds.includes(frame.turn_id);
      // A provider can start an autonomous response after the current answer's
      // final transcript, even if its model_end marker has not arrived yet.
      // Earlier input origins remain fenced, so a late old answer cannot use
      // this path to take over a newer question.
      const autonomousAfterFinal =
        role === "one" &&
        state.activeInputTurnId !== null &&
        frame.turn_id !== state.activeInputTurnId &&
        !state.fencedTurnIds.includes(frame.turn_id) &&
        state.transcript.some(
          (item) =>
            item.role === "one" &&
            item.turnId === state.activeInputTurnId &&
            item.final,
        );
      if (role === "one" && isStaleOrigin(state, frame.turn_id) && !autonomousAfterFinal)
        return state;
      if (role === "one" && state.clearedTurnIds.includes(frame.turn_id)) {
        // An answer that was mid-sentence when the view was cleared belongs
        // to the cleared exchange, so its remaining chunks and its
        // finalization stay out. Once it ends there is nothing left to
        // suppress.
        //
        // Only the answer is suppressed. A turn id covers BOTH sides of the
        // exchange, and the relay stamps a typed message with the turn
        // already in flight, so suppressing by turn id alone swallowed the
        // person's own next message and let their final un-suppress the
        // answer. What someone says or types is never stale history.
        return {
          ...state,
          turnId: frame.turn_id,
          idleDeadlineAt: null,
          clearedTurnIds: frame.final
            ? state.clearedTurnIds.filter((id) => id !== frame.turn_id)
            : state.clearedTurnIds,
        };
      }
      const segment = transcriptSegment(frame);
      const { transcript, transcriptSeq } = segment
        ? mergeContractedTranscript(
            state.transcript,
            state.transcriptSeq,
            role,
            frame.turn_id,
            frame.text,
            segment,
          )
        : mergeTranscript(
            state.transcript,
            state.transcriptSeq,
            role,
            frame.turn_id,
            frame.text,
            frame.final,
          );
      return {
        ...state,
        turnId: isStaleOrigin(state, frame.turn_id) && !newInput && !autonomousAfterFinal
          ? state.turnId
          : frame.turn_id,
        activeInputTurnId: newInput
          ? frame.turn_id
          : autonomousAfterFinal ? null : state.activeInputTurnId,
        activeResponseTurnId: role === "one"
          ? frame.turn_id
          : newInput ? null : state.activeResponseTurnId,
        fencedTurnIds: autonomousAfterFinal
          ? addFencedTurns(state.fencedTurnIds, state.activeInputTurnId)
          : newInput
          ? addFencedTurns(
              state.fencedTurnIds,
              state.activeInputTurnId,
              state.activeResponseTurnId,
              state.pendingAction?.origin_turn_id,
            ).filter((id) => id !== frame.turn_id)
          : state.fencedTurnIds,
        // A new question owns the visible answer slot. Older tool receipts
        // remain in the timeline and any pending action still settles by ID.
        lastResult:
          newInput && !keepsAnswerSlotAcrossInput(state.lastResult)
            ? null
            : state.lastResult,
        toolTimeline: newInput
          ? state.toolTimeline.map((item) => item.tool === "open_screen" ? { ...item, navigationSuperseded: true } : item)
          : state.toolTimeline,
        phase:
          newInput && state.phase !== "paused" && state.phase !== "error"
            ? "understanding"
            : state.phase,
        idleDeadlineAt: null,
        transcript,
        transcriptSeq,
        historyCleared: hasVisibleTranscript(transcript)
          ? false
          : state.historyCleared,
      };
    }
    case "turn": {
      const transcript =
        frame.state === "interrupted" || frame.state === "model_end"
          ? fenceTurnTranscript(state.transcript, frame.turn_id)
          : state.transcript;
      return {
        ...state,
        turnId: isStaleOrigin(state, frame.turn_id) ? state.turnId : frame.turn_id,
        activeInputTurnId:
          (frame.state === "model_end" || frame.state === "interrupted") &&
          state.activeInputTurnId === frame.turn_id
            ? null
            : state.activeInputTurnId,
        activeResponseTurnId: !isStaleOrigin(state, frame.turn_id)
          ? frame.turn_id
          : state.activeResponseTurnId,
        // A completed origin can finish audio already scheduled by the player,
        // but late frames must never reclaim a later question's answer slot.
        fencedTurnIds:
          frame.state === "model_end" || frame.state === "interrupted"
            ? addFencedTurns(state.fencedTurnIds, frame.turn_id)
            : state.fencedTurnIds,
        transcript,
        toolTimeline: frame.state === "interrupted"
          ? state.toolTimeline.map((item) => item.tool === "open_screen" && item.turnId === frame.turn_id ? { ...item, navigationSuperseded: true } : item)
          : state.toolTimeline,
        idleDeadlineAt: null,
      };
    }
    case "state": {
      if (isStaleOrigin(state, frame.turn_id)) return state;
      // The relay can send an untagged listening state while a queued typed
      // input is waiting for the previous provider turn to finish.
      if (!frame.turn_id && frame.state === "listening" && state.activeInputTurnId)
        return state;
      const phase = mapServerStateToPhase(state.phase, frame.state);
      return {
        ...state,
        serverState: frame.state,
        phase: state.phase === "paused" && frame.state !== "error" ? "paused" : phase,
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
        turnId: frame.turn_id || null,
        tool: frame.tool,
        argsSummary: summarizeArgs(frame.args_public),
      };
      return {
        ...state,
        idleDeadlineAt: null,
        activeResponseTurnId: !isStaleOrigin(state, frame.turn_id)
          ? frame.turn_id || state.activeResponseTurnId
          : state.activeResponseTurnId,
        toolTimeline: [...state.toolTimeline, item].slice(-MAX_TIMELINE_ITEMS),
      };
    }
    case "tool.result": {
      const ok = frame.ok === true;
      const result = frame.result_public;
      const matchingCall = frame.call_id
        ? [...state.toolTimeline].reverse().find((item) => item.callId === frame.call_id)
        : undefined;
      const originTurnId = frame.turn_id || matchingCall?.turnId || null;
      // Missing correlation may still settle its exact pending card, but it
      // cannot take ownership of a newer question's answer slot.
      const belongsToCurrentInput = originTurnId
        ? !isStaleOrigin(state, originTurnId)
        : state.turnId === null && state.activeInputTurnId === null &&
          state.activeResponseTurnId === null;
      // A normal confirmed action emits `pending_action.resolved` first, but
      // a terminal result can still arrive without that frame after a relay
      // reconnect. Its exact pending id lets the client retire only the card
      // it settles; matching by tool name could close a newer confirmation.
      const pending = state.pendingAction;
      const pendingActionId = String(frame.pending_action_id || "").trim();
      const matchesOpenPending = Boolean(
        pending &&
          pending.resolvedStatus === null &&
          pendingActionId &&
          pendingActionId === pending.pending_action_id,
      );
      const awaitingDevice = isPendingStatus(result.status);
      const resolvedStatus: PendingActionView["resolvedStatus"] =
        awaitingDevice || ok ? "executed" : "failed";
      // A device-settled result reuses the originating call id; it replaces
      // the interim `location_updates_pending` entry rather than adding one.
      // The Save My Soul delivery report has no call id (the trigger was a
      // tap-confirmed card), so it is keyed on the interim status instead: it
      // replaces the armed entry so the panel shows one SOS card, not two.
      const index = frame.call_id
        ? findLastIndex(
            state.toolTimeline,
            (item) =>
              item.callId === frame.call_id &&
              (!item.result ||
                item.result.status === "location_updates_pending"),
          )
        : frame.tool === SOS_REPORT_TOOL
          ? findLastIndex(
              state.toolTimeline,
              (item) => item.result?.status === SOS_GRANTS_CREATED,
            )
          : -1;
      let timeline: ToolTimelineItem[];
      if (index === -1) {
        timeline = [
          ...state.toolTimeline,
          {
            callId: frame.call_id,
            turnId: originTurnId,
            tool: frame.tool,
            argsSummary: "",
            result,
            ok,
          },
        ].slice(-MAX_TIMELINE_ITEMS);
      } else {
        timeline = state.toolTimeline.slice();
        timeline[index] = {
          ...timeline[index]!,
          turnId: originTurnId || timeline[index]!.turnId,
          tool: frame.tool || timeline[index]!.tool,
          result,
          ok,
        };
      }
      return {
        ...state,
        idleDeadlineAt: null,
        phase:
          belongsToCurrentInput &&
          matchesOpenPending && resolvedStatus === "executed" && !awaitingDevice
            ? "complete"
            : belongsToCurrentInput && matchesOpenPending &&
                state.phase !== "paused" &&
                state.phase !== "error"
              ? "listening"
              : state.phase,
        toolTimeline: timeline,
        // A dispatch does not replace what is displayed. There is exactly one
        // result slot and no history, so letting a dispatch land in it would
        // clear the card it refers to: "open the second one" would take away the
        // list that made "second" mean anything. It still joins the timeline, so
        // it is observable; it just does not become the thing on screen.
        lastResult: DISPATCH_ONLY_STATUSES.has(String(result.status || "").trim()) ||
          !belongsToCurrentInput ||
          (isConfirmationHandoff(result) && keepsAnswerSlotAcrossInput(state.lastResult))
          ? state.lastResult
          : result,
        pendingAction:
          matchesOpenPending && pending
            ? {
                ...pending,
                status: resolvedStatus,
                result,
                receiptToken: null,
                resolvedStatus,
                resolvedResult: result,
              }
            : pending,
      };
    }
    case "pending_action": {
      if (isStaleOrigin(state, frame.turn_id)) return state;
      const {
        type: _type,
        turn_id: _turnId,
        risk_level,
        requires_tap,
        entities,
        receipt_token,
        ...row
      } = frame;
      void _type;
      void _turnId;
      const pending: PendingActionView = {
        ...row,
        riskLevel: risk_level,
        requiresTap: requires_tap === true || row.tier === "tap",
        entities: Array.isArray(entities)
          ? entities.slice(0, MAX_ENTITIES)
          : [],
        receiptToken: receipt_token || null,
        offeredResult:
          state.pendingAction?.pending_action_id === row.pending_action_id
            ? state.pendingAction.offeredResult
            : keepsAnswerSlotAcrossInput(state.lastResult)
              ? state.lastResult ?? undefined
              : undefined,
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
      // "complete" is a success-looking phase. An executed resolution whose
      // result is still awaiting the device (an armed Save My Soul:
      // `sos_grants_created`) has completed nothing yet, so the phase stays
      // listening until the settled result arrives; the relay says the same.
      const awaitingDevice = isPendingStatus(frame.result_public?.status);
      return {
        ...state,
        // Only the list kept beside this exact card yields to its result. A
        // newer answer or a resolution with no result stays on screen.
        lastResult:
          frame.result_public && state.lastResult === current!.offeredResult
            ? null
            : state.lastResult,
        idleDeadlineAt: null,
        phase:
          state.activeInputTurnId
            ? state.phase
            : executed && !awaitingDevice
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
      if (isStaleOrigin(state, frame.turn_id)) return state;
      const { type: _type, turn_id: _turnId, ...payload } = frame;
      void _type;
      void _turnId;
      const confirmedId =
        payload.kind === "person" ? payload.user_id : payload.circle_id;
      const picker = state.candidatePicker;
      const confirmedCandidate =
        Boolean(confirmedId) &&
        picker?.kind === payload.kind &&
        picker.candidates.some(
          (candidate) =>
            (picker.kind === "person" ? candidate.user_id : candidate.circle_id) ===
            confirmedId,
        );
      return {
        ...state,
        idleDeadlineAt: null,
        entities: upsertEntity(state.entities, payload),
        candidatePicker: confirmedCandidate ? null : picker,
      };
    }
    case "candidate_picker":
      if (isStaleOrigin(state, frame.turn_id)) return state;
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
      if (isStaleOrigin(state, frame.turn_id)) return state;
      // Directives are side effects the provider runs; the reducer only notes activity.
      return state.idleDeadlineAt === null
        ? state
        : { ...state, idleDeadlineAt: null };
    case "client_step.request":
      if (isStaleOrigin(state, frame.turn_id)) return state;
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

// --- close while a device step is outstanding --------------------------------

/**
 * The honest outcome of a Save My Soul alert whose publish step never settled
 * because this session ended first. The grants exist (the alert is armed);
 * whether a position reached anyone is unknown to this device, and a new
 * session cannot settle the old step, so the card must stop saying "sending".
 * Never "sent", never "not sent": `report_save_my_soul_delivery` decides that.
 */
export const SOS_CLOSED_UNVERIFIED_REASON = "client_session_closed" as const;
export const SOS_CLOSED_UNVERIFIED_FACT =
  "The connection dropped before delivery was confirmed. Ask 'did it go through?' or check Save My Soul.";

function closedUnverifiedResult(armed: ToolResultPublic): ToolResultPublic {
  const expected = Array.isArray(armed.grant_ids)
    ? armed.grant_ids.map((id) => String(id ?? "")).filter(Boolean)
    : [];
  return {
    status: "sos_unverified",
    reason_code: SOS_CLOSED_UNVERIFIED_REASON,
    spoken_facts: [SOS_CLOSED_UNVERIFIED_FACT],
    delivered: [],
    not_alerted: [],
    expected_grant_ids: expected,
    alert_active: expected.length > 0,
  };
}

/**
 * On a socket close, an armed-but-unsettled Save My Soul (the card and the
 * timeline entry still say `sos_grants_created`) becomes `sos_unverified`
 * with a client reason, so nothing spins forever and nothing reads as sent.
 * Unrelated state is returned untouched (same reference).
 */
export function settleArmedSosOnClose(
  state: VoiceSessionState,
): VoiceSessionState {
  const pending = state.pendingAction;
  const cardArmed = Boolean(
    pending &&
      pending.resolvedStatus !== null &&
      isPendingStatus(pending.resolvedResult?.status),
  );
  const index = findLastIndex(state.toolTimeline, (item) =>
    isPendingStatus(item.result?.status),
  );
  if (!cardArmed && index === -1) return state;
  const source =
    (cardArmed ? pending!.resolvedResult : null) ??
    state.toolTimeline[index]?.result ??
    {};
  const marker = closedUnverifiedResult(source as ToolResultPublic);
  let timeline = state.toolTimeline;
  let lastResult = state.lastResult;
  if (index !== -1) {
    timeline = state.toolTimeline.slice();
    const item = timeline[index]!;
    if (lastResult === item.result) lastResult = marker;
    timeline[index] = { ...item, result: marker, ok: false };
  }
  if (cardArmed && lastResult === pending!.resolvedResult) lastResult = marker;
  return {
    ...state,
    toolTimeline: timeline,
    lastResult,
    pendingAction: cardArmed
      ? {
          ...pending!,
          result: marker,
          resolvedResult: marker,
        }
      : state.pendingAction,
  };
}

// --- reducer ------------------------------------------------------------------

export function reduceVoiceSession(
  state: VoiceSessionState,
  event: VoiceSessionEvent,
): VoiceSessionState {
  switch (event.type) {
    case "navigation_settled": {
      if (isStaleNavigation(state, event.callId, event.turnId)) return state;
      const index = findLastIndex(state.toolTimeline, (item) =>
        item.callId === event.callId && item.tool === "open_screen" &&
        (!event.turnId || item.turnId === event.turnId),
      );
      if (index < 0 || state.toolTimeline[index]!.navigationOutcome) return state;
      const timeline = state.toolTimeline.slice();
      // tool.started precedes the directive. Retain settlement on that entry
      // even if navigation completes before tool.result arrives.
      timeline[index] = { ...timeline[index]!, navigationOutcome: event.status };
      return { ...state, toolTimeline: timeline };
    }
    case "reset":
      return INITIAL_VOICE_SESSION_STATE;
    case "clear_view": {
      // A presentation clear. The socket, the mic, the turn and One's own
      // conversation context are untouched; only what this client displays
      // changes. Work that was still running keeps its card so its outcome is
      // not lost, and an unresolved error stays because it is recovery
      // content, not history.
      const pending = state.pendingAction;
      return {
        ...state,
        transcript: [],
        entities: [],
        toolTimeline: [],
        lastResult: null,
        pendingAction:
          pending &&
          (pending.resolvedStatus === null ||
            pending.tool === SOS_TRIGGER_TOOL)
            ? pending
            : null,
        clearedTurnIds: Array.from(
          new Set(
            state.transcript
              .filter((item) => !item.final && item.role === "one")
              .map((item) => item.turnId),
          ),
        ).slice(-MAX_CLEARED_TURN_IDS),
        historyCleared: true,
      };
    }
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
          activeInputTurnId: null,
          activeResponseTurnId: null,
          fencedTurnIds: [],
          // The next relay may be older; it says what it accepts in session.ready.
          relayFeatures: [],
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
      // A device step outstanding at close is lost with the session (a
      // reconnect starts a new one that cannot settle it): an armed Save My
      // Soul stops saying "sending" and says the outcome is unconfirmed.
      const settled = settleArmedSosOnClose(state);
      return {
        ...settled,
        phase: reconnecting ? "connecting" : "idle",
        serverState: null,
        speaking: false,
        level: 0,
        clientStep: null,
        candidatePicker: null,
        idleDeadlineAt: null,
        relayFeatures: [],
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

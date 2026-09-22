/**
 * Wire protocol `one-voice-v1` between the app and the One Live Voice relay.
 *
 * Mirrors consent-protocol/hushh_mcp/one_voice/protocol.py. JSON text frames,
 * discriminated on `type`. Audio is base64 PCM16: 16 kHz up, 24 kHz down.
 * Every server frame about an action carries the same typed payload the
 * model narrates from, so the UI and the speech never disagree.
 */

export const ONE_VOICE_PROTOCOL_VERSION = "one-voice-v1" as const;
export const INPUT_MIME = "audio/pcm;rate=16000" as const;
export const OUTPUT_MIME = "audio/pcm;rate=24000" as const;

// --- client -> server ---------------------------------------------------------

export type AuthFrame = {
  type: "auth";
  vault_owner_token: string;
  firebase_id_token?: string | null;
  conversation_id: string;
  client?: Record<string, unknown>;
  resume?: boolean;
};
export type AudioFrame = { type: "audio"; data: string; mime_type?: string; seq?: number };
export type TextFrame = { type: "text"; text: string };
export type AppContextFrame = {
  type: "app_context";
  screen_id?: string | null;
  route?: string | null;
  available_action_ids?: string[];
  screen_state?: Record<string, unknown>;
  os_location_permission?: OsPermission;
  /**
   * Canonical id of the circle whose detail screen is open, so "this circle"
   * resolves server-side. Typed and separate from `screen_state` (which is
   * rendered into the prompt and carries no identifiers); a hint the relay
   * reads through the authorized circle service, never authority.
   */
  active_circle_id?: string | null;
};
export type PendingShownFrame = { type: "pending_action.shown"; pending_action_id: string };
export type ConfirmActionFrame = {
  type: "confirm_action";
  pending_action_id: string;
  receipt_token?: string | null;
  source?: "tap";
  firebase_id_token?: string | null;
  consent_version?: string | null;
};
export type CancelActionFrame = {
  type: "cancel_action";
  pending_action_id?: string | null;
  scope?: "pending_action" | "turn" | "session";
};
export type CandidateChooseFrame = {
  type: "candidate.choose";
  kind?: "person" | "circle";
  id?: string | null;
  none?: boolean;
};
export type ClientStepResultFrame = {
  type: "client_step.result";
  step_id: string;
  status: "ok" | "failed";
  payload?: Record<string, unknown>;
};
export type UiSettledFrame = {
  type: "ui.settled";
  directive_id: string;
  status?: "opened" | "failed" | "ignored";
};
export type InterruptFrame = { type: "interrupt" };
export type PingFrame = { type: "ping" };
export type EndFrame = { type: "end" };

export type ClientFrame =
  | AuthFrame
  | AudioFrame
  | TextFrame
  | AppContextFrame
  | PendingShownFrame
  | ConfirmActionFrame
  | CancelActionFrame
  | CandidateChooseFrame
  | ClientStepResultFrame
  | UiSettledFrame
  | InterruptFrame
  | PingFrame
  | EndFrame;

export type OsPermission = "unknown" | "prompt" | "granted" | "denied";

// --- server -> client ---------------------------------------------------------

export type VoiceState =
  | "listening"
  | "understanding"
  | "asking"
  | "confirming"
  | "executing"
  | "complete"
  | "error";

export type PendingActionPublic = {
  pending_action_id: string;
  tool: string;
  gateway_action_id: string;
  tier: "voice" | "tap";
  summary: string;
  args: Record<string, unknown>;
  status: "pending" | "confirmed" | "executed" | "failed" | "cancelled" | "expired";
  shown_at: string | null;
  expires_at: string | null;
  result: Record<string, unknown> | null;
};

export type EntityCardPayload = {
  kind: "person" | "circle";
  user_id?: string;
  circle_id?: string;
  display_name?: string;
  name?: string;
  photo_url?: string | null;
  relationship?: "connected" | "pending_outgoing" | "pending_incoming" | "none" | "self";
  has_location_key?: boolean;
  kind_label?: string;
  member_count?: number | null;
};

export type CandidatePublic = {
  user_id?: string;
  circle_id?: string;
  public_person_ref?: string | null;
  display_name?: string;
  name?: string;
  photo_url?: string | null;
  relationship?: string;
  match_tier?: number;
  has_location_key?: boolean;
};

export type ToolResultPublic = {
  status: string;
  spoken_facts?: string[];
  needs?: string | null;
  reason_code?: string | null;
  ui_refresh?: string[];
  client_step?: Record<string, unknown>;
  [key: string]: unknown;
};

export type SessionReadyFrame = {
  type: "session.ready";
  protocol_version: typeof ONE_VOICE_PROTOCOL_VERSION;
  session_id: string;
  conversation_id: string;
  model: string;
  resumed: boolean;
  idle_timeout_ms: number;
  session_max_ms: number;
  pending_actions: PendingActionPublic[];
  setup_progress: Record<string, unknown> | null;
  output_mime_type: typeof OUTPUT_MIME;
};
export type AudioOutFrame = { type: "audio"; data: string; mime_type: string; turn_id: string };
export type TranscriptFrame = {
  type: "transcript.input" | "transcript.output";
  text: string;
  final: boolean;
  turn_id: string;
};
export type TurnFrame = { type: "turn"; state: "model_start" | "model_end" | "interrupted"; turn_id: string };
export type StateFrame = { type: "state"; state: VoiceState; turn_id?: string | null };
export type ToolStartedFrame = { type: "tool.started"; call_id: string; tool: string; args_public: Record<string, unknown> };
export type ToolResultFrame = {
  type: "tool.result";
  call_id: string | null;
  /** Exact pending confirmation this terminal result settles, when there is one. */
  pending_action_id?: string | null;
  tool: string;
  status: string;
  ok: boolean;
  result_public: ToolResultPublic;
};
export type PendingActionFrame = PendingActionPublic & {
  type: "pending_action";
  risk_level: "low" | "medium" | "high";
  requires_tap: boolean;
  entities: EntityCardPayload[];
  receipt_token?: string;
};
export type PendingResolvedFrame = {
  type: "pending_action.resolved";
  pending_action_id: string;
  status: "executed" | "failed" | "cancelled" | "expired" | "not_pending";
  result_public: ToolResultPublic | null;
};
export type EntityCardFrame = EntityCardPayload & { type: "entity_card" };
export type CandidatePickerFrame = {
  type: "candidate_picker";
  kind: "person" | "circle";
  question: string;
  candidates: CandidatePublic[];
};
export type UiDirectiveKind =
  | "navigate"
  | "refresh"
  | "publish_location_envelopes"
  | "request_os_permission"
  | "open_share_sheet"
  | "focus_pending_action";
export type UiDirectiveFrame = {
  type: "ui_directive";
  directive_id: string;
  kind: UiDirectiveKind;
  payload: Record<string, unknown>;
};
export type ClientStepRequestFrame = {
  type: "client_step.request";
  step_id: string;
  kind: string;
  payload: Record<string, unknown>;
  timeout_s: number;
};
export type ReconnectRequiredFrame = { type: "session.reconnect_required"; reason: "go_away" | "max_duration" };
export type PongFrame = { type: "pong" };
export type ErrorFrame = { type: "error"; code: string; message: string };

export type ServerFrame =
  | SessionReadyFrame
  | AudioOutFrame
  | TranscriptFrame
  | TurnFrame
  | StateFrame
  | ToolStartedFrame
  | ToolResultFrame
  | PendingActionFrame
  | PendingResolvedFrame
  | EntityCardFrame
  | CandidatePickerFrame
  | UiDirectiveFrame
  | ClientStepRequestFrame
  | ReconnectRequiredFrame
  | PongFrame
  | ErrorFrame;

const SERVER_TYPES = new Set<string>([
  "session.ready",
  "audio",
  "transcript.input",
  "transcript.output",
  "turn",
  "state",
  "tool.started",
  "tool.result",
  "pending_action",
  "pending_action.resolved",
  "entity_card",
  "candidate_picker",
  "ui_directive",
  "client_step.request",
  "session.reconnect_required",
  "pong",
  "error",
]);

/** Parse one raw socket message; unknown or malformed frames return null. */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !SERVER_TYPES.has(type)) return null;
  return value as ServerFrame;
}

// Application close codes (mirrors the backend).
export const CLOSE_CODES = {
  disabled: 4001,
  auth: 4003,
  ticket: 4004,
  protocol: 4008,
  idle: 4009,
  maxDuration: 4010,
  providerUnavailable: 4013,
  capacity: 4029,
  replaced: 4030,
  ended: 1000,
} as const;

/**
 * Save My Soul on the wire. `trigger_save_my_soul` can only ARM the alert
 * (`SOS_GRANTS_CREATED`): the position is encrypted on the device, so what
 * reached whom is a fact only `report_save_my_soul_delivery` may state, from
 * the stored envelopes. Nothing in this file, and nothing rendered from these
 * statuses, may call an armed alert "sent" or "done".
 */
export const SOS_TRIGGER_TOOL = "trigger_save_my_soul" as const;
export const SOS_REPORT_TOOL = "report_save_my_soul_delivery" as const;
export const SOS_STOP_TOOL = "stop_save_my_soul" as const;
export const SOS_GRANTS_CREATED = "sos_grants_created" as const;
export const SOS_PUBLISH_STEP_KIND = "publish_location_envelopes" as const;
export const SOS_PUBLISH_PURPOSE = "sos" as const;
/** The verified delivery outcomes, and only these, may say who was reached. */
export const SOS_REPORT_STATUSES = new Set<string>([
  "sos_sent",
  "sos_partial",
  "sos_not_sent",
  "sos_unverified",
]);

/** Statuses that must never render as success. */
export const NOT_SUCCESS_STATUSES = new Set<string>([
  "rejected",
  "unsupported",
  "confirmation_required",
  "tap_required",
  "card_not_shown",
  // A firebase-plane card that needs a tap with a fresh sign-in proof.
  "firebase_proof_required",
  // The scope-review screen is open; nothing has been accepted yet.
  "scope_review_required",
  "navigation_dispatched",
  "grant_created",
  "check_in_created",
  "sos_grants_created",
  "position_publish_pending",
  "location_updates_pending",
  "pending",
  "not_pending",
  "consent_required",
  "setup_required",
]);

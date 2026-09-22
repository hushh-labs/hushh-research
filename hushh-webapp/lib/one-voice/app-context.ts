/**
 * The `app_context` frame One Live Voice sends the relay.
 *
 * Built from what the app already publishes for the agent: the voice surface
 * metadata a screen mounts (`screenId`, its offered action ids and scalar
 * `screenState`) and the redacted runtime snapshot. It carries no names,
 * identifiers, tokens or free text: ids of actions and screens, scalar state,
 * the route, and the OS location permission. Everything is bounded so a busy
 * screen can never grow the frame past what the relay accepts.
 */

import type { AgentRuntimeState } from "@/lib/agent/agent-runtime-context";
import type { AppContextFrame, OsPermission } from "@/lib/one-voice/protocol";
import {
  getVoiceSurfaceMetadata,
  type VoiceSurfaceMetadata,
} from "@/lib/voice/voice-surface-metadata";

/**
 * A screen that learns the device permission first-hand (the Location
 * publisher after `request_os_permission`) reports it here; the provider
 * resends `app_context` with the new value.
 */
export const ONE_VOICE_OS_PERMISSION_EVENT = "one-voice:os-permission" as const;
export type OneVoiceOsPermissionDetail = { permission: OsPermission };

export function reportOsLocationPermission(permission: OsPermission): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<OneVoiceOsPermissionDetail>(ONE_VOICE_OS_PERMISSION_EVENT, {
      detail: { permission },
    }),
  );
}

export const MAX_APP_CONTEXT_ACTION_IDS = 200;
export const MAX_APP_CONTEXT_STATE_KEYS = 40;
const MAX_SCREEN_ID_CHARS = 120;
const MAX_ROUTE_CHARS = 400;
/** A canonical circle id is a UUID; anything else is not sent. */
const CIRCLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STATE_STRING_CHARS = 200;
const MAX_ACTION_ID_CHARS = 120;

const OS_PERMISSIONS = new Set<OsPermission>([
  "unknown",
  "prompt",
  "granted",
  "denied",
]);

export type BuildAppContextInput = {
  runtime: AgentRuntimeState | null;
  pathname: string | null;
  /** The device's location permission when the caller knows it; else derived. */
  osLocationPermission?: OsPermission | null;
  /** Injectable for tests; defaults to the published voice surface. */
  surface?: VoiceSurfaceMetadata | null;
};

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanActionId(value: unknown): string | null {
  const text = cleanText(value, MAX_ACTION_ID_CHARS);
  if (!text) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : null;
}

/**
 * Map the redacted runtime permission onto the wire's OS permission. The
 * runtime snapshot folds "restricted" (iOS parental controls, MDM) into what
 * the relay needs to know: the prompt cannot succeed.
 */
export function deriveOsLocationPermission(
  runtime: AgentRuntimeState | null,
): OsPermission {
  const value =
    runtime?.oneVoiceContextSnapshot?.redacted_state?.permission_state;
  switch (value) {
    case "granted":
      return "granted";
    case "denied":
    case "restricted":
      return "denied";
    default:
      return "unknown";
  }
}

/** Screen id: the published surface first, then the runtime's route screen. */
export function resolveAppContextScreenId(
  runtime: AgentRuntimeState | null,
  surface: VoiceSurfaceMetadata | null,
): string | null {
  return (
    cleanText(surface?.screenId, MAX_SCREEN_ID_CHARS) ??
    cleanText(
      runtime?.oneVoiceContextSnapshot?.route?.screen,
      MAX_SCREEN_ID_CHARS,
    ) ??
    cleanText(runtime?.screen, MAX_SCREEN_ID_CHARS)
  );
}

/**
 * The action ids the relay may consider on this screen: what the surface
 * offers, in publication order, then the runtime's executable inventory.
 * De-duplicated and capped at the relay's limit.
 */
export function collectAvailableActionIds(
  runtime: AgentRuntimeState | null,
  surface: VoiceSurfaceMetadata | null,
): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const push = (value: unknown) => {
    const id = cleanActionId(value);
    if (!id || seen.has(id) || output.length >= MAX_APP_CONTEXT_ACTION_IDS)
      return;
    seen.add(id);
    output.push(id);
  };
  for (const id of surface?.availableActions ?? []) push(id);
  for (const action of surface?.actions ?? [])
    push(action?.actionId ?? action?.id);
  for (const control of surface?.controls ?? []) push(control?.actionId);
  const snapshot = runtime?.oneVoiceContextSnapshot;
  for (const id of snapshot?.executable_action_ids ?? []) push(id);
  for (const id of snapshot?.available_action_ids ?? []) push(id);
  return output;
}

/**
 * Scalar screen state only. Strings are trimmed and capped, numbers must be
 * finite, and anything else (objects, arrays, functions) is dropped: the
 * relay sanitises again, but nothing that is not a scalar leaves the device.
 */
export function collectScreenState(
  runtime: AgentRuntimeState | null,
  surface: VoiceSurfaceMetadata | null,
): Record<string, string | number | boolean | null> {
  const output: Record<string, string | number | boolean | null> = {};
  let count = 0;
  const put = (key: string, value: unknown) => {
    if (count >= MAX_APP_CONTEXT_STATE_KEYS) return;
    const name = cleanText(key, 64);
    if (!name || name in output) return;
    let clean: string | number | boolean | null;
    if (value === null) clean = null;
    else if (typeof value === "boolean") clean = value;
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) return;
      clean = value;
    } else if (typeof value === "string") {
      clean = value.trim().slice(0, MAX_STATE_STRING_CHARS);
    } else return;
    output[name] = clean;
    count += 1;
  };
  const redacted = runtime?.oneVoiceContextSnapshot?.redacted_state;
  if (redacted) {
    put("circle_count", redacted.circle_count ?? null);
    put("share_state", redacted.share_state ?? null);
    put("current_location_state", redacted.current_location_state ?? null);
  }
  if (surface?.activeTab) put("active_tab", surface.activeTab);
  if (surface?.activeSection) put("active_section", surface.activeSection);
  if (surface?.modalState) put("modal_state", surface.modalState);
  for (const [key, value] of Object.entries(surface?.screenState ?? {}))
    put(key, value);
  return output;
}

/**
 * The circle the open screen is about, or null. Only a well-formed canonical
 * id leaves the device: the relay refuses anything else as a protocol error.
 */
export function collectActiveCircleId(
  surface: VoiceSurfaceMetadata | null,
): string | null {
  const raw = surface?.activeCircleId;
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return CIRCLE_ID_PATTERN.test(id) ? id : null;
}

/** Build one `app_context` frame from the app's published state. */
export function buildAppContextFrame(
  input: BuildAppContextInput,
): AppContextFrame {
  const surface =
    input.surface === undefined ? getVoiceSurfaceMetadata() : input.surface;
  const permission =
    input.osLocationPermission && OS_PERMISSIONS.has(input.osLocationPermission)
      ? input.osLocationPermission
      : deriveOsLocationPermission(input.runtime);
  return {
    type: "app_context",
    screen_id: resolveAppContextScreenId(input.runtime, surface),
    route: cleanText(input.pathname, MAX_ROUTE_CHARS),
    available_action_ids: collectAvailableActionIds(input.runtime, surface),
    screen_state: collectScreenState(input.runtime, surface),
    os_location_permission: permission,
    active_circle_id: collectActiveCircleId(surface),
  };
}

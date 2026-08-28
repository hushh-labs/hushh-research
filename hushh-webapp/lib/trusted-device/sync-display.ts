import { formatRelativeTime } from "@/lib/format/relative-time";

/** The subset of a trusted-device row that drives the sync-status display. */
export interface DeviceSyncFields {
  status: "active" | "revoked" | string;
  created_at?: number | null;
  last_used_at?: number | null;
  revoked_at?: number | null;
  last_synced_at?: number | null;
  sealed_at?: number | null;
  /** Advisory liveness telemetry posted by the running device (migration 186). */
  last_heartbeat_at?: number | null;
  heartbeat?: { current_model?: string; busy?: boolean } | null;
}

/**
 * How recently a device must have checked in to be called reachable. The agent
 * heartbeats every 5 minutes, so this allows one missed beat before the label
 * falls back to trust-only -- long enough to absorb a retry or a sleep/wake,
 * short enough that "reachable now" stays honest.
 */
export const HEARTBEAT_FRESH_MS = 11 * 60 * 1000;

export type SyncTone = "active" | "neutral" | "muted";

export interface SyncDisplay {
  label: string;
  tone: SyncTone;
}

/**
 * Bounded window separating "awaiting device seal confirmation" from the honest
 * terminal "seal unconfirmed". Loosely tied to the native detector cadence.
 */
export const SEAL_CONFIRM_WINDOW_MS = 10 * 60 * 1000;

/**
 * Client-derived sync display from the raw server fields. The server emits only
 * status and timestamps and never a display verdict, so all UI state is derived
 * here and stays reload-stable given the same (fields, nowMs). It is
 * deliberately honest:
 *  - never claims a device is sealed as fact, only "device reported sealed";
 *  - never relabels last_used_at (a capability mint) as a sync;
 *  - renders anything it cannot classify as "unavailable", never a false
 *    "stopped" or "revoked".
 */
export function deriveSyncDisplay(
  device: DeviceSyncFields,
  nowMs: number,
): SyncDisplay {
  if (device.status === "active") {
    // A fresh heartbeat is the ONLY evidence the agent is actually running, so
    // it is the only thing that may say so. Everything below it reports trust
    // and sync time instead, because status alone means "still authorized" and
    // last_synced_at only moves when the device pulls the sync channel.
    if (
      device.last_heartbeat_at != null &&
      nowMs - device.last_heartbeat_at <= HEARTBEAT_FRESH_MS
    ) {
      const model = device.heartbeat?.current_model;
      return {
        label: model ? `Active now · running ${model}` : "Active now",
        tone: "active",
      };
    }
    // "Trusted", not "Active": no fresh heartbeat means the server cannot say
    // whether the agent is running. Saying "Active" next to a two-day-old sync
    // reads as "reachable now", which the data cannot support.
    if (device.last_synced_at != null) {
      return {
        label: `Trusted · last synced ${formatRelativeTime(device.last_synced_at, nowMs)}`,
        tone: "active",
      };
    }
    return { label: "Trusted · not yet synced", tone: "neutral" };
  }

  if (device.status === "revoked") {
    if (device.sealed_at != null) {
      return {
        label: `Revoked · device reported sealed ${formatRelativeTime(device.sealed_at, nowMs)}`,
        tone: "muted",
      };
    }
    const sinceRevoke =
      device.revoked_at != null
        ? nowMs - device.revoked_at
        : Number.POSITIVE_INFINITY;
    if (sinceRevoke <= SEAL_CONFIRM_WINDOW_MS) {
      return {
        label: "Revoked · awaiting device seal confirmation",
        tone: "neutral",
      };
    }
    return { label: "Revoked · seal unconfirmed", tone: "muted" };
  }

  return { label: "Sync status unavailable", tone: "muted" };
}

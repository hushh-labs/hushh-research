/** Owner-scoped trusted-device observation shared by Puppy surfaces. */
import { ApiService } from "@/lib/services/api-service";
import { registerPeriodicTask } from "@/lib/perf/idle-scheduler";
import { HEARTBEAT_FRESH_MS } from "@/lib/trusted-device/sync-display";
import { withAbortDeadline } from "@/lib/utils/request-timeouts";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent, type AuthSessionOwnerSnapshot } from "@/lib/auth/session-owner";

/**
 * One scheduled job, as the DEVICE describes it on its heartbeat.
 *
 * This is an ALLOW-LIST on the wire, not a filtered copy of the local job API
 * (`PuppyJob` above). The device builds each row out of these fields alone and
 * drops any row it cannot build, so there is no shape in which a prompt, a
 * script, a working directory, a filesystem path, a URL, a token or a model
 * credential can ride along. That is what makes a snapshot safe to store on
 * One's servers and to show to a viewer who is nowhere near the machine.
 *
 * Adding a field here is therefore not a frontend change: it is a change to
 * what leaves the owner's Mac.
 *
 * `next_at` is epoch SECONDS, unlike `next_cron_at` and every other clock in
 * this file, which are epoch ms. The unit is the contract's, not ours, and a
 * reader that forgets to multiply dates every job to January 1970.
 */
export interface PuppyHeartbeatScheduledJob {
  /** The job's display name. Trimmed, up to 80 characters. */
  name: string;
  /** The schedule in words or in cron: "every 15m", "0 5 * * 0". */
  when: string;
  /** The scheduler's own word for off. Deliberate, never a fault. */
  paused: boolean;
  /** Epoch SECONDS. Omitted when the device does not know. */
  next_at?: number;
  /** Last run result: "ok", "error". Trimmed, up to 16 characters. */
  last?: string;
}

/**
 * One recent conversation, as the DEVICE describes it on its heartbeat.
 *
 * The same allow-list rule as `PuppyHeartbeatScheduledJob`: a title, a count
 * and a time. No message body, no tool output, nothing a conversation was
 * actually about. `at` is epoch SECONDS.
 */
export interface PuppyHeartbeatConversation {
  /** Trimmed, up to 80 characters. */
  title: string;
  /** How many messages the conversation holds. */
  messages: number;
  /** Epoch SECONDS of the last activity. */
  at: number;
}

/**
 * The runtime snapshot a device posts with its heartbeat, as One stores it.
 *
 * Field names stay snake_case: this is the backend's allow-list
 * (`_safe_heartbeat` in `trusted_device_service.py`) read back verbatim, and
 * every field is optional because a device sends only what it can measure. A
 * desktop omits the battery fields entirely rather than sending 0, so an
 * absent field must render as nothing and never as a number.
 */
export interface PuppyLinkHeartbeat {
  current_model?: string;
  busy?: boolean;
  active_sessions?: number;
  /** Epoch ms of the next scheduled job on the device. */
  next_cron_at?: number;
  agent_version?: string;
  machine_id?: string;
  brand?: string;
  processor?: string;
  ram_total_gb?: number;
  ram_used_pct?: number;
  battery_pct?: number;
  battery_minutes_remaining?: number;
  battery_charging?: boolean;
  on_ac?: boolean;
  /**
   * Up to 10 scheduled jobs, SOONEST first, so a truncated list is the useful
   * half. The order is the device's and is rendered as sent, never re-sorted.
   *
   * Absent and empty are different facts and must stay different all the way
   * to the screen: absent means the device did not report its schedule at all
   * (an older agent, or a probe that failed), while `[]` means it reported
   * having nothing scheduled. Defaulting one to the other would either invent
   * an answer or hide one the owner gave.
   */
  scheduled?: PuppyHeartbeatScheduledJob[];
  /**
   * Up to 10 recent conversations, NEWEST first. Same absent-vs-empty rule as
   * `scheduled`.
   */
  conversations?: PuppyHeartbeatConversation[];
}

export interface PuppyLinkDevice {
  id: string;
  name: string;
  /** Epoch ms. Null when the device has never reported. */
  lastHeartbeatAt: number | null;
  /** Epoch ms. Null when the device has never pulled the sync channel. */
  lastSyncedAt: number | null;
  heartbeat: PuppyLinkHeartbeat | null;
}

/**
 * Whether Hussh One has a Puppy One to point at, as the BACKEND sees it.
 *
 *   live         an active device reported within `HEARTBEAT_FRESH_MS`.
 *   quiet        an active device exists but none has reported recently:
 *                asleep, offline, or never reported at all.
 *   unlinked     no device has ever been connected to this account.
 *   revoked      every device this account had was unlinked.
 *   unavailable  the list could not be read. Says nothing about the device.
 *
 * `device` is set for `live` and `quiet` only: the active device with the
 * freshest heartbeat, falling back to the most recently created one.
 */
export type PuppyLinkState =
  | "live"
  | "quiet"
  | "unlinked"
  | "revoked"
  | "unavailable";

export interface PuppyLink {
  state: PuppyLinkState;
  device: PuppyLinkDevice | null;
  /** How many devices are still trusted, whatever their liveness. */
  activeCount: number;
  /** Epoch ms of the read, and the base every relative time is measured from. */
  checkedAt: number;
}

interface TrustedDeviceRow {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  lastHeartbeatAt: number | null;
  lastSyncedAt: number | null;
  heartbeat: PuppyLinkHeartbeat | null;
}

function epochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One backend row, read defensively.
 *
 * A row that is not an object, or has no id, is skipped rather than allowed
 * to throw: the caller must be able to say "unavailable" for a malformed list
 * and still say "live" for a well-formed row beside a broken one.
 */
function readRow(value: unknown): TrustedDeviceRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.device_id === "string" ? row.device_id.trim() : "";
  if (!id || row.platform !== "macos") return null;
  const name =
    typeof row.device_name === "string" && row.device_name.trim()
      ? row.device_name.trim()
      : "your Mac";
  const heartbeat =
    row.heartbeat && typeof row.heartbeat === "object"
      ? (row.heartbeat as PuppyLinkHeartbeat)
      : null;
  return {
    id,
    name,
    status: typeof row.status === "string" ? row.status : "",
    createdAt: epochMs(row.created_at) ?? 0,
    lastHeartbeatAt: epochMs(row.last_heartbeat_at),
    lastSyncedAt: epochMs(row.last_synced_at),
    heartbeat,
  };
}

function toLinkDevice(row: TrustedDeviceRow): PuppyLinkDevice {
  return {
    id: row.id,
    name: row.name,
    lastHeartbeatAt: row.lastHeartbeatAt,
    lastSyncedAt: row.lastSyncedAt,
    heartbeat: row.heartbeat,
  };
}

/** Freshest heartbeat first; among the never-reported, newest enrolment first. */
function preferFresher(
  a: TrustedDeviceRow,
  b: TrustedDeviceRow,
): TrustedDeviceRow {
  const aBeat = a.lastHeartbeatAt ?? Number.NEGATIVE_INFINITY;
  const bBeat = b.lastHeartbeatAt ?? Number.NEGATIVE_INFINITY;
  if (aBeat !== bBeat) return aBeat > bBeat ? a : b;
  return b.createdAt > a.createdAt ? b : a;
}

/**
 * Read the link state out of the backend's device list. Pure, so the same
 * (rows, now) always answers the same way and a test can pin every branch.
 *
 * The freshness window is the SAME constant the devices page uses to say
 * "Active now", so the two surfaces cannot disagree about one machine.
 */
export function derivePuppyLink(devices: unknown, nowMs: number): PuppyLink {
  if (!Array.isArray(devices)) {
    return {
      state: "unavailable",
      device: null,
      activeCount: 0,
      checkedAt: nowMs,
    };
  }

  const rows = devices
    .map(readRow)
    .filter((row): row is TrustedDeviceRow => row !== null);
  const active = rows.filter((row) => row.status === "active");
  const revoked = rows.filter((row) => row.status === "revoked");

  if (active.length === 0) {
    return {
      state: revoked.length > 0 ? "revoked" : "unlinked",
      device: null,
      activeCount: 0,
      checkedAt: nowMs,
    };
  }

  const chosen = active.reduce(preferFresher);
  const fresh = active.some(
    (row) =>
      row.lastHeartbeatAt !== null &&
      nowMs - row.lastHeartbeatAt <= HEARTBEAT_FRESH_MS,
  );
  return {
    state: fresh ? "live" : "quiet",
    device: toLinkDevice(chosen),
    activeCount: active.length,
    checkedAt: nowMs,
  };
}

/**
 * Read the link to Hussh One from One's own backend. Never throws: a failed
 * read is "unavailable", which the surfaces render calmly, and is
 * deliberately NOT "unlinked", which would tell a person with a working
 * device to go and install one.
 */
export async function fetchPuppyLink(signal?: AbortSignal): Promise<PuppyLink> {
  const checkedAt = Date.now();
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner) return derivePuppyLink(null, checkedAt);
  const current = () => isValidatedAuthSessionOwnerCurrent(owner);
  try {
    const response = await ApiService.listTrustedDevices({ signal, isCurrentOwner: current });
    if (!response.ok) return derivePuppyLink(null, checkedAt);
    const payload = (await response.json()) as { devices?: unknown } | null;
    if (!current()) return derivePuppyLink(null, checkedAt);
    return derivePuppyLink(payload?.devices, checkedAt);
  } catch {
    return derivePuppyLink(null, checkedAt);
  }
}

/**
 * One reader of the link for the whole page.
 *
 * Chat and machine status share one poller so they cannot disagree about a
 * device's heartbeat. A minute is enough for the device's ten-minute keepalive.
 */
export const PUPPY_LINK_POLL_MS = 60_000;
const PUPPY_LINK_READ_DEADLINE_MS = 20_000;

type LinkListener = (link: PuppyLink | null) => void;

const linkStore: {
  owner: AuthSessionOwnerSnapshot | null;
  link: PuppyLink | null;
  listeners: Set<LinkListener>;
  /** The poll's unregister handle while a subscriber exists. */
  timer: (() => void) | null;
  inFlight: Promise<PuppyLink> | null;
} = { owner: null, link: null, listeners: new Set(), timer: null, inFlight: null };

/** The last link read, or null before the first read lands. */
export function getPuppyLinkSnapshot(): PuppyLink | null {
  return linkStore.owner && isValidatedAuthSessionOwnerCurrent(linkStore.owner) ? linkStore.link : null;
}

/**
 * Re-read the link now. Single-flight: a second caller while a read is in
 * the air shares that read rather than starting another. Every subscriber
 * hears the answer at once.
 */
export function refreshPuppyLink(): Promise<PuppyLink> {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner) {
    linkStore.owner = null;
    linkStore.link = null;
    linkStore.inFlight = null;
    return Promise.resolve(derivePuppyLink(null, Date.now()));
  }
  if (!linkStore.owner || !isValidatedAuthSessionOwnerCurrent(linkStore.owner)) {
    linkStore.owner = owner;
    linkStore.link = null;
    linkStore.inFlight = null;
  }
  if (linkStore.inFlight) return linkStore.inFlight;
  const read = withAbortDeadline(
    fetchPuppyLink, PUPPY_LINK_READ_DEADLINE_MS, () => derivePuppyLink(null, Date.now()),
  ).then((next) => {
    // A retired read must not publish a device or clear the next owner's read.
    if (!isValidatedAuthSessionOwnerCurrent(owner) || linkStore.inFlight !== read) {
      return derivePuppyLink(null, Date.now());
    }
    linkStore.inFlight = null;
    linkStore.link = next;
    for (const listener of linkStore.listeners) listener(next);
    return next;
  });
  linkStore.inFlight = read;
  return read;
}

/**
 * Subscribe to the link. The first subscriber starts the poll and the last
 * one leaving stops it, so a page with no Puppy surface costs One nothing.
 * `useSyncExternalStore` shaped: the listener is called with the new value.
 */
export function subscribePuppyLink(listener: LinkListener): () => void {
  linkStore.listeners.add(listener);
  if (!getPuppyLinkSnapshot()) void refreshPuppyLink();
  if (linkStore.timer === null) {
    // On the shared idle clock (one wake with the other polls, after a
    // frame, never while hidden); the handle is the unregister function.
    linkStore.timer = registerPeriodicTask({
      id: "puppy:link",
      intervalMs: PUPPY_LINK_POLL_MS,
      run: async () => {
        await refreshPuppyLink();
      },
    });
  }
  return () => {
    linkStore.listeners.delete(listener);
    if (linkStore.listeners.size === 0 && linkStore.timer !== null) {
      linkStore.timer();
      linkStore.timer = null;
    }
  };
}

/** Test seam: forget the last read and stop any poll. */
export function resetPuppyLinkStoreForTests(): void {
  if (linkStore.timer !== null) linkStore.timer();
  linkStore.timer = null;
  linkStore.owner = null;
  linkStore.link = null;
  linkStore.inFlight = null;
  linkStore.listeners.clear();
}

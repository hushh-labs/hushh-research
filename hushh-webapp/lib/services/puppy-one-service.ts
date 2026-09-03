/**
 * Puppy One data access.
 *
 * Every call to the local-agent route proxies lives here rather than in the
 * panel or the picker, per the service-layer rule: UI surfaces do not own
 * network calls. That matters more than usual for this feature, because the
 * failure modes are unusually mundane -- Hermes is simply not running on this
 * machine most of the time -- and each surface inventing its own handling
 * produces a different flavour of "broken" for the same ordinary state.
 *
 * These endpoints are Next route handlers on our own origin. The loopback
 * bearer key never reaches the browser; the route handler holds it.
 *
 * One reading here does NOT go over loopback: the link to Hussh One
 * (`fetchPuppyLink`) is read from One's own backend, which every deployed
 * viewer can reach. The bridge answers "is a gateway on THIS server", which on
 * a deployed origin is never the owner's Mac; the backend answers "has the
 * owner's machine reported in", which is the fact a person actually wants.
 */

import { ApiService } from "@/lib/services/api-service";
import { HEARTBEAT_FRESH_MS } from "@/lib/trusted-device/sync-display";

export interface PuppyStatus {
  connected: boolean;
  reason?: string;
  message?: string;
  model?: string | null;
  busy?: boolean;
}

/** The build a model file is. `null` means the gateway does not know. */
export type PuppyModelVariant = "MLX" | "GGUF";

/**
 * One pickable model.
 *
 * Only `id` is guaranteed. The gateway omits a field it cannot answer for, and
 * an omission is information: "unknown" and "none" are different facts about a
 * model, so nothing here carries a default and every surface renders an absent
 * field as nothing at all rather than as a placeholder or a guess.
 */
export interface PuppyModel {
  id: string;
  /** "MLX" or "GGUF". Null/absent means unknown, which is not an error. */
  variant?: PuppyModelVariant | null;
  /** As the model host words it: "4bit", "Q4_K_M". */
  quantization?: string | null;
  /**
   * "loaded" | "not-loaded" | something this build has not seen. Read as an
   * open string so an unfamiliar value degrades to "not shown" instead of
   * being mapped onto the nearest state we do recognise.
   */
  state?: string | null;
  supportsReasoning?: boolean;
}

export interface PuppyProvider {
  id: string;
  name: string;
  /** False means answering here sends the turn off this machine. */
  onDevice: boolean;
  /** The provider the running agent is answering from. */
  isCurrent?: boolean;
  /**
   * Already filtered to authenticated providers and deduplicated by the
   * gateway, which is the only place that knows which credentials are live.
   * Surfaces render this list; they do not re-derive it.
   */
  models: PuppyModel[];
}

export interface PuppyModelOptions {
  configured: boolean;
  reachable?: boolean;
  providers: PuppyProvider[];
  current?: { model: string; provider: string };
  reasoningEfforts?: string[];
}

export interface PuppyModelAssignment {
  ok: boolean;
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
  /** Hermes writes config; only a NEW session reads it. */
  appliesTo?: "next-session";
  confirmRequired?: boolean;
  confirmMessage?: string;
  error?: string;
}

/**
 * The machine reading behind `/api/hermes/resources`.
 *
 * Field names stay snake_case because this route is a pass-through: the
 * gateway owns the vocabulary, and renaming here would mean maintaining a
 * second one that drifts. Every field and every section is optional, because
 * the gateway OMITS a section whose probe could not answer. A missing section
 * means "not readable", never zero, so nothing below carries a default.
 */
export interface PuppyResourceBattery {
  present?: boolean;
  percent?: number;
  state?: string;
  charging?: boolean;
  on_ac?: boolean;
}

export interface PuppyResourceAgent {
  model?: string;
  provider?: string;
  /** The provider answering this turn runs on this machine. */
  on_device?: boolean;
  /** `hussh_one.on_device_only`: auxiliary work is refused rather than sent out. */
  on_device_gate?: boolean;
  active_agents?: number;
  busy?: boolean;
  version?: string;
}

export interface PuppyResourceMachine {
  brand?: string;
  processor?: string;
  cpu_cores?: number;
  ram_total_gb?: number;
  ram_available_gb?: number;
  ram_used_pct?: number;
  battery?: PuppyResourceBattery;
  disk_total_gb?: number;
  disk_free_gb?: number;
  disk_used_pct?: number;
}

export interface PuppyResidentModel {
  id?: string;
  size_gb?: number;
  status?: string;
  context?: number;
  is_current?: boolean;
}

export interface PuppyResourceModels {
  resident?: PuppyResidentModel[];
  resident_gb?: number;
  available_gb?: number;
}

/**
 * Whether Hussh One can still SEE this machine.
 *
 * Enrolment and login are different lifetimes: a device stays trusted after its
 * login dies, so every local probe keeps reporting a healthy machine while One
 * has not heard from it in weeks. That gap is invisible from the device's own
 * point of view, which is why it is reported here and shown first.
 *
 * `session` is read as an open string, not a closed union: a value this build
 * does not recognise must degrade to "cannot be checked" rather than being
 * mapped onto the nearest known state.
 */
export interface PuppyResourceLink {
  connected?: boolean;
  account_email?: string;
  environment?: string;
  /** "ok" | "expired" | "revoked" | "not_connected" | "indeterminate" | unknown */
  session?: string;
  heartbeat_live?: boolean;
  /** The fix, worded by the gateway. Rendered verbatim or not at all. */
  remedy?: string;
}

export interface PuppyResourceJobs {
  enabled?: number;
  disabled?: number;
  next?: { at?: string; name?: string };
  last_24h?: { completed?: number; failed?: number; other?: number };
}

export interface PuppyResources {
  configured: boolean;
  reachable?: boolean;
  reason?: string;
  message?: string;
  /** Gateway clock, epoch ms. The relative-time base, so no clock skew. */
  generated_at?: number;
  link?: PuppyResourceLink;
  agent?: PuppyResourceAgent;
  machine?: PuppyResourceMachine;
  models?: PuppyResourceModels;
  jobs?: PuppyResourceJobs;
}

/**
 * One scheduled job, as `/api/hermes/jobs` hands it over.
 *
 * camelCase, unlike the readings above, because this route does NOT pass the
 * gateway's row through: it maps field by field and drops the job's prompt,
 * its credentials and its working directory before the payload ever leaves the
 * server. The shape is the route's own, so it is named here in the same words
 * the route uses.
 *
 * `null` means "the gateway did not say", never zero and never "no". A job
 * with no `schedule` is not a job that never runs; it is a job whose schedule
 * this build could not read, and it renders as nothing rather than as a guess.
 */
export interface PuppyJob {
  id: string;
  name: string;
  /** "10 3 * * *", "every 30m", or whatever the scheduler calls it. */
  schedule: string | null;
  /** The scheduler's own word for off. Deliberate, not an error. */
  paused: boolean;
  /** ISO with offset, e.g. "2026-09-03T03:10:00-07:00". */
  nextRunAt: string | null;
  /** "ok" | "error" | anything a later gateway invents. Read as an open string. */
  lastStatus: string | null;
  lastError: string | null;
  failureStreak: number;
}

export interface PuppyJobs {
  configured: boolean;
  reachable?: boolean;
  reason?: string;
  message?: string;
  jobs: PuppyJob[];
}

export interface PuppyJobChange {
  ok: boolean;
  id?: string;
  action?: string;
  job?: PuppyJob | null;
  error?: string;
}

const STATUS_TIMEOUT_MS = 10_000;
const OPTIONS_TIMEOUT_MS = 25_000;
const ASSIGN_TIMEOUT_MS = 35_000;
const RESOURCES_TIMEOUT_MS = 20_000;
const JOBS_TIMEOUT_MS = 15_000;
const JOB_CHANGE_TIMEOUT_MS = 20_000;

/** Read Puppy One's status. Never throws: not-running is an ordinary state. */
export async function fetchPuppyStatus(): Promise<PuppyStatus> {
  try {
    const response = await fetch("/api/hermes/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return { connected: false, reason: "unreachable" };
    return (await response.json()) as PuppyStatus;
  } catch {
    // A machine without Hermes running is normal, not a failure. Surfacing it
    // as an error would make the common case look broken.
    return { connected: false, reason: "unreachable" };
  }
}

/**
 * Read the machine Puppy One runs on. Never throws: a machine with no agent
 * answering is an ordinary state, and the monitor renders it as one.
 */
export async function fetchPuppyResources(): Promise<PuppyResources> {
  try {
    const response = await fetch("/api/hermes/resources", {
      cache: "no-store",
      signal: AbortSignal.timeout(RESOURCES_TIMEOUT_MS),
    });
    if (!response.ok) return { configured: true, reachable: false };
    return (await response.json()) as PuppyResources;
  } catch {
    return { configured: true, reachable: false };
  }
}

/**
 * Read the work Puppy One does on a schedule. Never throws, for the same
 * reason the readings do not: a machine with no agent answering is ordinary.
 *
 * `jobs` is always an array. A caller rendering a list must not have to decide
 * what an absent array means, and the two states that are NOT "no jobs" --
 * not configured, and not answering -- are carried by their own fields.
 */
export async function fetchPuppyJobs(): Promise<PuppyJobs> {
  try {
    const response = await fetch("/api/hermes/jobs", {
      cache: "no-store",
      signal: AbortSignal.timeout(JOBS_TIMEOUT_MS),
    });
    if (!response.ok) return { configured: true, reachable: false, jobs: [] };
    const payload = (await response.json()) as PuppyJobs;
    return {
      ...payload,
      jobs: Array.isArray(payload?.jobs) ? payload.jobs : [],
    };
  } catch {
    return { configured: true, reachable: false, jobs: [] };
  }
}

/**
 * Pause or resume one job.
 *
 * Resolves rather than throws for every outcome: an unreachable gateway is an
 * ordinary state, and the caller has to be able to leave the switch showing
 * the job's REAL state when the machine refuses. The returned `job` is the
 * gateway's own row for it; callers still re-read the list afterwards rather
 * than trusting a single row to be the whole truth.
 */
export async function setPuppyJobPaused(input: {
  id: string;
  paused: boolean;
}): Promise<PuppyJobChange> {
  try {
    const response = await fetch("/api/hermes/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: input.id,
        action: input.paused ? "pause" : "resume",
      }),
      signal: AbortSignal.timeout(JOB_CHANGE_TIMEOUT_MS),
    });
    const payload = (await response
      .json()
      .catch(() => ({}))) as PuppyJobChange;
    if (payload?.ok === true) return payload;
    return {
      ok: false,
      error: payload?.error || "Puppy One could not change that job.",
    };
  } catch {
    return { ok: false, error: "Puppy One is not answering on this machine." };
  }
}

/** List the providers and models Puppy One can reach. */
export async function fetchPuppyModelOptions(
  options: { refresh?: boolean } = {},
): Promise<PuppyModelOptions> {
  try {
    const response = await fetch(
      `/api/hermes/models${options.refresh ? "?refresh=1" : ""}`,
      { cache: "no-store", signal: AbortSignal.timeout(OPTIONS_TIMEOUT_MS) },
    );
    return (await response.json()) as PuppyModelOptions;
  } catch {
    return { configured: true, reachable: false, providers: [] };
  }
}

/**
 * Pin a model.
 *
 * Resolves rather than throws for the two non-success outcomes, because
 * neither is an exception: an expensive model returns a question
 * (`confirmRequired`) that the owner has to answer, and an unreachable agent
 * returns an ordinary state.
 */
export async function assignPuppyModel(input: {
  provider: string;
  model: string;
  reasoningEffort?: string;
  confirmExpensive?: boolean;
}): Promise<PuppyModelAssignment> {
  try {
    const response = await fetch("/api/hermes/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(ASSIGN_TIMEOUT_MS),
    });
    return (await response.json()) as PuppyModelAssignment;
  } catch {
    return { ok: false, error: "Puppy One is not answering on this machine." };
  }
}

/** Where Puppy One is installed from. Public, so it is linked, not described. */
export const PUPPY_ONE_INSTALL_URL =
  "https://github.com/hushh-labs/hussh-one-hermes";

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
  if (!id) return null;
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
export async function fetchPuppyLink(): Promise<PuppyLink> {
  const checkedAt = Date.now();
  try {
    const response = await ApiService.listTrustedDevices();
    if (!response.ok) return derivePuppyLink(null, checkedAt);
    const payload = (await response.json()) as { devices?: unknown } | null;
    return derivePuppyLink(payload?.devices, checkedAt);
  } catch {
    return derivePuppyLink(null, checkedAt);
  }
}

/**
 * One reader of the link for the whole page.
 *
 * The chat panel and the machine strip both need this fact, and when each
 * polled it on its own cadence the two disagreed on screen: the pill turned
 * green within thirty seconds of a heartbeat while the strip above it kept
 * saying One had not heard from the machine for another five minutes. One
 * fact, one poller, one moment of change. The device pushes a keepalive every
 * ten minutes, so a read a minute is already generous.
 */
export const PUPPY_LINK_POLL_MS = 60_000;

type LinkListener = (link: PuppyLink | null) => void;

const linkStore: {
  link: PuppyLink | null;
  listeners: Set<LinkListener>;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<PuppyLink> | null;
} = { link: null, listeners: new Set(), timer: null, inFlight: null };

/** The last link read, or null before the first read lands. */
export function getPuppyLinkSnapshot(): PuppyLink | null {
  return linkStore.link;
}

/**
 * Re-read the link now. Single-flight: a second caller while a read is in
 * the air shares that read rather than starting another. Every subscriber
 * hears the answer at once.
 */
export function refreshPuppyLink(): Promise<PuppyLink> {
  if (linkStore.inFlight) return linkStore.inFlight;
  const read = fetchPuppyLink().then((next) => {
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
  if (linkStore.timer === null) {
    void refreshPuppyLink();
    linkStore.timer = setInterval(() => void refreshPuppyLink(), PUPPY_LINK_POLL_MS);
  }
  return () => {
    linkStore.listeners.delete(listener);
    if (linkStore.listeners.size === 0 && linkStore.timer !== null) {
      clearInterval(linkStore.timer);
      linkStore.timer = null;
    }
  };
}

/** Test seam: forget the last read and stop any poll. */
export function resetPuppyLinkStoreForTests(): void {
  if (linkStore.timer !== null) clearInterval(linkStore.timer);
  linkStore.timer = null;
  linkStore.link = null;
  linkStore.inFlight = null;
  linkStore.listeners.clear();
}

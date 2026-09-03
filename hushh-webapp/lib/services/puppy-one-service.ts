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
 */

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
  onDevice?: boolean;
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

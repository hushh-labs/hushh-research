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

const STATUS_TIMEOUT_MS = 10_000;
const OPTIONS_TIMEOUT_MS = 25_000;
const ASSIGN_TIMEOUT_MS = 35_000;
const RESOURCES_TIMEOUT_MS = 20_000;

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

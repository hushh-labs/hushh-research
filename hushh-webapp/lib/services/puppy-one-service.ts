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

export interface PuppyModel {
  id: string;
  supportsReasoning: boolean;
}

export interface PuppyProvider {
  id: string;
  name: string;
  /** False means answering here sends the turn off this machine. */
  onDevice: boolean;
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

const STATUS_TIMEOUT_MS = 10_000;
const OPTIONS_TIMEOUT_MS = 25_000;
const ASSIGN_TIMEOUT_MS = 35_000;

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

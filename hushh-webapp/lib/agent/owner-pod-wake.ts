/**
 * Sending a chat turn to a private agent that sleeps when idle.
 *
 * An owner's agent can scale to zero (Azure Container Apps, Cloud Run). Its
 * first request after a quiet spell waits 30 to 40 s while it starts, and the
 * ingress may refuse it outright with a gateway status while it does. Neither
 * is a failed turn: the person sees "Waking your agent" and the same turn is
 * sent once the agent answers.
 *
 * Only failures that prove the turn never reached the agent are retried:
 * a network failure before the turn was handed over (`PodNotReachedError`),
 * a refused admission with a gateway status, or a gateway status on the send
 * itself that is not the agent's own JSON answer. A network failure on the send
 * is ambiguous (the agent may already be running the turn), so it is reported
 * as `PodSendUnconfirmedError`, never resent. A device that reports itself
 * offline is told so (`DeviceOfflineError`) instead of being shown a wake.
 */

/** Waiting this long for the agent's first byte means it is starting up. */
export const WAKE_HINT_MS = 3_000;
/** A measured cold start is 30 to 40 s; give it three times that before giving up. */
export const WAKE_BUDGET_MS = 120_000;
const WAKE_MAX_DELAY_MS = 8_000;
const WAKE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, WAKE_MAX_DELAY_MS];

export const POD_NOT_REACHED = "POD_NOT_REACHED";
export const POD_WAKE_TIMEOUT = "POD_WAKE_TIMEOUT";
export const POD_SEND_UNCONFIRMED = "POD_SEND_UNCONFIRMED";
export const POD_DEVICE_OFFLINE = "POD_DEVICE_OFFLINE";

/** The agent could not be reached before the turn was handed to it. */
export class PodNotReachedError extends Error {
  readonly code = POD_NOT_REACHED;

  constructor() {
    super(POD_NOT_REACHED);
    this.name = "PodNotReachedError";
  }
}

/** The agent did not answer within the wake budget. The turn was not sent. */
export class AgentWakeTimeoutError extends Error {
  readonly code = POD_WAKE_TIMEOUT;

  constructor() {
    super(POD_WAKE_TIMEOUT);
    this.name = "AgentWakeTimeoutError";
  }
}

/**
 * The turn was handed to the transport and no answer came back (a connection
 * reset, a dropped network). The agent may or may not have received it, so it
 * is never resent automatically.
 */
export class PodSendUnconfirmedError extends Error {
  readonly code = POD_SEND_UNCONFIRMED;

  constructor() {
    super(POD_SEND_UNCONFIRMED);
    this.name = "PodSendUnconfirmedError";
  }
}

/** The device reported itself offline when a step before the send failed. */
export class DeviceOfflineError extends Error {
  readonly code = POD_DEVICE_OFFLINE;

  constructor() {
    super(POD_DEVICE_OFFLINE);
    this.name = "DeviceOfflineError";
  }
}

/** `navigator.onLine` is only trusted when it says false. */
function deviceIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** A step before the send got no answer: offline, or the agent is not reachable yet. */
export function notReachedBeforeSend(): PodNotReachedError | DeviceOfflineError {
  return deviceIsOffline() ? new DeviceOfflineError() : new PodNotReachedError();
}

/**
 * Run one step that happens before the turn is handed to the agent (admission,
 * session renewal). A network failure there proves the turn was never sent.
 */
export async function beforeTurnIsSent<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof TypeError) throw notReachedBeforeSend();
    throw error;
  }
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);
const WAKING_REFUSAL = /^(?:POD_CHALLENGE_REFUSED|POD_ADMISSION_REFUSED):(?:502|503|504)$/;

/**
 * Whether an outcome only says the agent is still starting. The agent's own
 * JSON refusal (busy, restarting, unavailable) is its answer and is shown as is.
 */
export function isAgentStillWaking(outcome: unknown): boolean {
  if (outcome instanceof Response) {
    if (!GATEWAY_STATUSES.has(outcome.status)) return false;
    return !(outcome.headers.get("content-type") ?? "").includes("application/json");
  }
  if (outcome instanceof PodNotReachedError) return true;
  return outcome instanceof Error && WAKING_REFUSAL.test(outcome.message);
}

export type AgentWakePorts = {
  /** Called once, when the agent is found to be starting up. */
  onWaking: () => void;
  /** Whether this turn goes to the owner's own agent; nothing else is woken. */
  isOwnerAgent: () => Promise<boolean>;
  signal?: AbortSignal | null;
  hintMs?: number;
  budgetMs?: number;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
};

type Settled = { response: Response; error?: undefined } | { response?: undefined; error: unknown };

function cancelled(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException("Agent turn cancelled", "AbortError");
}

function defaultWait(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function settleWithHint(send: () => Promise<Response>, hintMs: number, onSlow: () => void): Promise<Settled> {
  const hint = setTimeout(onSlow, hintMs);
  try {
    return { response: await send() };
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(hint);
  }
}

/**
 * Send once, and while the owner's agent is starting up, say so and send the
 * same request again until it answers or the wake budget runs out.
 */
export async function sendWhileAgentWakes(
  send: () => Promise<Response>,
  ports: AgentWakePorts,
): Promise<Response> {
  const now = ports.now ?? Date.now;
  const wait = ports.wait ?? defaultWait;
  const deadline = now() + (ports.budgetMs ?? WAKE_BUDGET_MS);
  let ownerAgent: Promise<boolean> | null = null;
  const isOwnerAgent = () => (ownerAgent ??= ports.isOwnerAgent().catch(() => false));
  let woke = false;
  const waking = () => {
    if (woke || ports.signal?.aborted) return;
    woke = true;
    ports.onWaking();
  };
  const hintIfOwnerAgent = () => void isOwnerAgent().then((owner) => owner && waking());
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await settleWithHint(send, ports.hintMs ?? WAKE_HINT_MS, hintIfOwnerAgent);
    const value = outcome.response ?? outcome.error;
    if (isAgentStillWaking(value) && ports.signal?.aborted) {
      void outcome.response?.body?.cancel().catch(() => undefined);
      throw cancelled(ports.signal);
    }
    if (!isAgentStillWaking(value) || !(await isOwnerAgent())) {
      if (outcome.response) return outcome.response;
      throw outcome.error;
    }
    void outcome.response?.body?.cancel().catch(() => undefined);
    const delay = WAKE_RETRY_DELAYS_MS[Math.min(attempt, WAKE_RETRY_DELAYS_MS.length - 1)] ?? WAKE_MAX_DELAY_MS;
    if (now() + delay >= deadline) throw new AgentWakeTimeoutError();
    waking();
    await wait(delay, ports.signal);
  }
}

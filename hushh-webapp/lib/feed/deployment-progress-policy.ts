/**
 * While a person's agent is being built, the Feed should follow it.
 *
 * Deployment is a live process — `reserved → provisioning → connecting →
 * active` — and the backend already writes a feed row at every one of those
 * transitions. The Feed simply never went back to look. `useStaleResource`
 * loads the list once on mount and deliberately does not force-refresh, so a
 * person watching their agent come up saw the unread badge tick at the 45s poll
 * while the rows underneath it stayed exactly as they were.
 *
 * The deliberate part is worth preserving rather than overriding: the list does
 * not refresh mid-visit so that unread styling stays stable while you are
 * reading. That is correct for an ordinary feed. It is wrong for the two
 * minutes when the thing you are waiting for is being built.
 *
 * So the rule is narrow: follow the list ONLY while a deployment is actually in
 * flight, at a cadence that suits a process measured in seconds, and stop the
 * moment it reaches a terminal state. Outside that window the Feed behaves
 * exactly as it does today.
 *
 * This module is the decision, not the mechanism, so it can be reasoned about
 * and tested without mounting anything.
 */

/** States the status endpoint can report (`_STATE_BY_REGISTRY_STATUS`). */
export type AgentDeploymentState =
  | "reserved"
  | "provisioning"
  | "connecting"
  | "active"
  | "failed";

/**
 * States where work is still happening and new feed rows are still arriving.
 *
 * `reserved` counts. It is both "identity reserved, not yet building" and the
 * backend's documented fail-safe for a missing row or an unrecognised status —
 * so treating it as live means a person whose provisioning silently failed to
 * start still gets a Feed that updates when it recovers, rather than one that
 * decided nothing was happening.
 */
const IN_FLIGHT: ReadonlySet<AgentDeploymentState> = new Set([
  "reserved",
  "provisioning",
  "connecting",
]);

/**
 * How often to re-read while a deployment is in flight.
 *
 * Six seconds against a process whose own steps take tens of seconds: fast
 * enough that a transition never feels missed, slow enough that a two-minute
 * provision costs ~20 requests rather than the ~200 a one-second poll would.
 * The 45s badge cadence is far too slow here — a whole deployment can begin and
 * end inside one of its intervals.
 */
export const DEPLOYMENT_POLL_INTERVAL_MS = 6_000;

/**
 * Stop following after this long even if the state never settles.
 *
 * A deployment that has not reached a terminal state in ten minutes is stuck,
 * and a stuck deployment must not leave a browser tab polling forever. The
 * ceiling is what makes this safe to arm automatically: the failure mode of a
 * never-terminating state machine is a bounded number of requests, not an
 * unbounded one.
 */
export const DEPLOYMENT_FOLLOW_CEILING_MS = 10 * 60 * 1000;

export function isDeploymentInFlight(state: string | null | undefined): boolean {
  if (!state) return false;
  return IN_FLIGHT.has(state as AgentDeploymentState);
}

export function isDeploymentTerminal(state: string | null | undefined): boolean {
  return state === "active" || state === "failed";
}

export type FollowDecision = {
  /** Should the Feed be polling right now? */
  follow: boolean;
  /** Milliseconds between reads while following. */
  intervalMs: number;
  /** Should the caller refresh the list because the state just changed? */
  refresh: boolean;
  /** Why — surfaced in telemetry so a follow that never stops is diagnosable. */
  reason: string;
};

/**
 * Decide what the Feed should do, given where the deployment is now and where
 * it was a moment ago.
 *
 * `previousState` is what makes a transition observable. Polling tells you the
 * current state; only comparing it to the last one tells you that something
 * *happened* — and a refresh on every poll rather than on every change would
 * reintroduce exactly the mid-visit churn the existing no-refresh comment
 * exists to prevent.
 */
export function decideFollow(options: {
  state: string | null | undefined;
  previousState: string | null | undefined;
  elapsedMs: number;
}): FollowDecision {
  const { state, previousState, elapsedMs } = options;
  const changed = Boolean(state) && state !== previousState;

  if (isDeploymentTerminal(state)) {
    // Refresh once on arrival so the final row lands, then stop.
    return {
      follow: false,
      intervalMs: DEPLOYMENT_POLL_INTERVAL_MS,
      refresh: changed,
      reason: changed ? "settled" : "terminal",
    };
  }

  if (!isDeploymentInFlight(state)) {
    return { follow: false, intervalMs: DEPLOYMENT_POLL_INTERVAL_MS, refresh: false, reason: "idle" };
  }

  if (elapsedMs >= DEPLOYMENT_FOLLOW_CEILING_MS) {
    // Stuck. Stop following, but do not claim the deployment failed — the
    // backend owns that verdict, and a client inventing one is how a UI starts
    // disagreeing with the system it is describing.
    return {
      follow: false,
      intervalMs: DEPLOYMENT_POLL_INTERVAL_MS,
      refresh: false,
      reason: "ceiling_reached",
    };
  }

  return {
    follow: true,
    intervalMs: DEPLOYMENT_POLL_INTERVAL_MS,
    refresh: changed,
    reason: changed ? "advanced" : "in_flight",
  };
}

"use client";

import { useEffect, useRef, useState } from "react";

import {
  decideFollow,
  DEPLOYMENT_POLL_INTERVAL_MS,
  type AgentDeploymentState,
} from "@/lib/feed/deployment-progress-policy";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { apiJson } from "@/lib/services/api-client";

type StatusResponse = { state?: string | null };

const VALID: readonly string[] = [
  "reserved",
  "provisioning",
  "connecting",
  "active",
  "failed",
];

/**
 * Follow a deployment while it is happening, and stop when it is not.
 *
 * Both surfaces that show deployment state fetched it exactly once on mount:
 * the dashboard presence chip (`one-agent-presence.tsx`) and, indirectly, the
 * Feed list. So the minutes when a person's agent is actually being built — the
 * one time the state changes on its own — were the minutes nothing updated.
 *
 * One hook serves both, because they are the same question asked twice. It owns
 * the polling and the transition detection; the POLICY of when to poll and when
 * a refresh is earned lives next door in a pure function, so the interesting
 * part is testable without mounting anything.
 *
 * On a real transition it dispatches the existing `FEED_STATE_CHANGED_EVENT`
 * rather than inventing a second bus. The unread badge already listens to that
 * event, so a deployment step now updates the badge immediately instead of on
 * the next 45s tick, and the Feed list can listen to the same thing.
 */
export function useAgentDeploymentFollow(options?: { enabled?: boolean }): {
  state: AgentDeploymentState | null;
  following: boolean;
} {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<AgentDeploymentState | null>(null);
  const [following, setFollowing] = useState(false);
  // Refs, not state: these drive the loop and must not themselves re-trigger it.
  const previousRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      let next: string | null = null;
      try {
        const res = await apiJson<StatusResponse>("/api/one/personal-agent/status");
        const raw = String(res?.state ?? "");
        next = VALID.includes(raw) ? raw : null;
      } catch {
        // A transient status failure is not a state change. Keep the last known
        // value and try again on the next tick -- guessing here would make the
        // UI disagree with the backend, which is the failure this whole surface
        // exists to avoid.
        next = previousRef.current;
      }
      if (cancelled) return;

      const decision = decideFollow({
        state: next,
        previousState: previousRef.current,
        elapsedMs: Date.now() - startedAtRef.current,
      });

      if (next && next !== previousRef.current) {
        setState(next as AgentDeploymentState);
        previousRef.current = next;
      }
      setFollowing(decision.follow);

      if (decision.refresh) {
        // The step actually advanced. Tell every feed surface at once.
        dispatchFeedStateChanged();
      }
      if (decision.follow) {
        timer = setTimeout(() => void tick(), decision.intervalMs);
      }
    };

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `enabled` only. Re-running on `state` would restart the clock that the
    // ceiling is measured against, and a follow that can restart its own
    // deadline has no ceiling at all.
  }, [enabled]);

  return { state, following };
}

export { DEPLOYMENT_POLL_INTERVAL_MS };

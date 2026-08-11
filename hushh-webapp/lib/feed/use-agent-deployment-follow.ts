"use client";

import { useEffect, useRef, useState } from "react";

import {
  decideFollow,
  deploymentTaskId,
  describeDeployment,
  DEPLOYMENT_POLL_INTERVAL_MS,
  DEPLOYMENT_TASK_KIND,
  isDeploymentInFlight,
  type AgentDeploymentState,
} from "@/lib/feed/deployment-progress-policy";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { ApiService } from "@/lib/services/api-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";

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
/**
 * Mirror the deployment into the app's existing background-work rail.
 *
 * Called only on a real transition, so the rail sees the same events the Feed
 * does. Without a `userId` there is nothing to key a task to and this is a
 * no-op -- the follow itself still works, because showing progress must not
 * depend on the rail being available.
 *
 * Every call is wrapped: this is a progress indicator, and a progress indicator
 * that can break the thing it reports on is worse than no indicator at all.
 */
function reportBackgroundTask(
  userId: string | null,
  state: AgentDeploymentState,
): void {
  if (!userId) return;
  const taskId = deploymentTaskId(userId);
  const copy = describeDeployment(state);
  try {
    if (isDeploymentInFlight(state)) {
      // startTask upserts on a fixed id, so re-entering the page updates the
      // existing card rather than stacking another one for the same deployment.
      AppBackgroundTaskService.startTask({
        userId,
        taskId,
        kind: DEPLOYMENT_TASK_KIND,
        title: copy.title,
        description: copy.description,
        routeHref: "/one/feed",
        visibility: "passive",
        groupLabel: "Private agent",
      });
      AppBackgroundTaskService.updateTask(taskId, {
        title: copy.title,
        description: copy.description,
      });
      return;
    }
    if (state === "active") {
      AppBackgroundTaskService.completeTask(taskId, copy.description);
      return;
    }
    // `failed` is the backend's verdict, never one this client invents.
    AppBackgroundTaskService.failTask(taskId, copy.title, copy.description);
  } catch {
    // Deliberately swallowed. See the note above.
  }
}

export function useAgentDeploymentFollow(options?: {
  enabled?: boolean;
  userId?: string | null;
}): {
  state: AgentDeploymentState | null;
  following: boolean;
  hushhId: string | null;
  health: string | null;
} {
  const enabled = options?.enabled ?? true;
  const userId = options?.userId ?? null;
  const [state, setState] = useState<AgentDeploymentState | null>(null);
  const [following, setFollowing] = useState(false);
  // The pod's address. Every surface that talks to a pod -- the relay, the turn,
  // pod info -- is keyed on this, and it was being discarded by a client type that
  // declared only `state`, which is why nothing in the product could reach a pod.
  const [hushhId, setHushhId] = useState<string | null>(null);
  // Present only when the liveness sweep reached a real verdict. Absent means
  // absent; the backend deliberately does not default it to "healthy".
  const [health, setHealth] = useState<string | null>(null);
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
        const res = await ApiService.getPersonalAgentStatus();
        const raw = String(res?.state ?? "");
        next = VALID.includes(raw) ? raw : null;
        if (!cancelled) {
          // Set outside the transition branch below: these are properties of the
          // agent, not of a state CHANGE. A pod that is already `active` when the
          // page loads never transitions, and keying its address off a transition
          // would leave it unaddressable for exactly the people who have one.
          setHushhId(res?.hushhId ? String(res.hushhId) : null);
          setHealth(res?.health ? String(res.health) : null);
        }
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
        const deployment = next as AgentDeploymentState;
        setState(deployment);
        previousRef.current = next;
        reportBackgroundTask(userId, deployment);
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
    // `enabled` and `userId` only. Re-running on `state` would restart the clock
    // that the ceiling is measured against, and a follow that can restart its own
    // deadline has no ceiling at all. `userId` is different in kind: a change
    // there means a different person, and that SHOULD start a fresh follow with
    // a fresh deadline and its own background-task card.
  }, [enabled, userId]);

  return { state, following, hushhId, health };
}

export { DEPLOYMENT_POLL_INTERVAL_MS };

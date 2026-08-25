"use client";

import { useEffect, useRef, useState } from "react";

import {
  decideFollow,
  deploymentTaskId,
  describeDeployment,
  DEPLOYMENT_FOLLOW_CEILING_MS,
  DEPLOYMENT_POLL_INTERVAL_MS,
  DEPLOYMENT_TASK_KIND,
  isDeploymentInFlight,
  type AgentDeploymentState,
} from "@/lib/feed/deployment-progress-policy";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { ApiService } from "@/lib/services/api-service";
import { AppBackgroundTaskService } from "@/lib/services/app-background-task-service";

// Three consecutive failures at the follow interval is ~seconds of sustained
// failure, which is past any single flaky request and well short of the minutes a
// person waits during provisioning.
const FAILURES_BEFORE_WARNING = 3;

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
  cloud: {
    project: string;
    region: string | null;
    credentialMode: string | null;
  } | null;
  // WHICH door this person took. Separate from `cloud` because a hosted agent
  // has no user-project coordinates to report and would otherwise be
  // indistinguishable from a person who has not chosen yet -- so the surface
  // would say nothing at all about where their agent lives, which is exactly
  // what it did before the hosted tier existed.
  deploymentTarget: string | null;
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
  // WHERE the agent lives and AS WHOM it reaches its model. The pod had no
  // visible identity anywhere in the product (founder finding, 2026-08-21).
  const [cloud, setCloud] = useState<{
    project: string;
    region: string | null;
    credentialMode: string | null;
  } | null>(null);
  const [deploymentTarget, setDeploymentTarget] = useState<string | null>(null);
  // Refs, not state: these drive the loop and must not themselves re-trigger it.
  const previousRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  // A run of failures, not a total: one flaky poll in a long session is noise, a
  // sustained run is the signal.
  const consecutiveFailuresRef = useRef<number>(0);

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
        consecutiveFailuresRef.current = 0;
        if (!cancelled) {
          // Set outside the transition branch below: these are properties of the
          // agent, not of a state CHANGE. A pod that is already `active` when the
          // page loads never transitions, and keying its address off a transition
          // would leave it unaddressable for exactly the people who have one.
          setHushhId(res?.hushhId ? String(res.hushhId) : null);
          setHealth(res?.health ? String(res.health) : null);
          setCloud(
            res?.cloudProject
              ? {
                  project: String(res.cloudProject),
                  region: res?.cloudRegion ? String(res.cloudRegion) : null,
                  credentialMode: res?.credentialMode ? String(res.credentialMode) : null,
                }
              : null,
          );
          setDeploymentTarget(
            res?.deploymentTarget ? String(res.deploymentTarget) : null,
          );
        }
      } catch (error) {
        consecutiveFailuresRef.current += 1;
        // A few transient failures are not a state change: keep the last known value
        // and try again -- guessing here would make the UI disagree with the backend.
        // But a PERSISTENT failure is different, and retaining `active` through it is
        // the "abandoned pod in the UI" bug: a status that 401s every tick after
        // LOGOUT, or a row DELETED out from under a stale session, otherwise renders
        // exactly like a healthy unchanged pod -- so the person keeps attending a pod
        // that may no longer exist. Past the warning window, stop trusting the stale
        // value and CLEAR the displayed agent, so the surface falls back to "no pod"
        // rather than a phantom one.
        if (consecutiveFailuresRef.current >= FAILURES_BEFORE_WARNING) {
          next = null;
          if (!cancelled) {
            setHushhId(null);
            setHealth(null);
          }
          if (consecutiveFailuresRef.current === FAILURES_BEFORE_WARNING) {
            console.warn(
              "[AgentDeployment] status has failed",
              FAILURES_BEFORE_WARNING,
              "times in a row; clearing the displayed agent rather than showing a stale pod.",
              error,
            );
          }
        } else {
          next = previousRef.current;
        }
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

    // The narrative stream, behind its flag, OFF by default. When on, the
    // cursored follower replaces this hook's own 6-second cadence -- but the
    // poll path never leaves the build: the follower itself starts on polling
    // for native and degrades to polling after repeated stream failures, hitting
    // the same JSON endpoint with the same frames. Flipping the flag back off
    // restores this exact loop untouched. The follower only ever REFINES what
    // the poll would have shown; terminal verdicts still come from frames, and
    // frames still come from the registry row.
    if (process.env.NEXT_PUBLIC_POD_LIFECYCLE_STREAM === "1") {
      const abort = new AbortController();
      // The ceiling survives the transport swap. decideFollow bounds the poll
      // path; the follower is bounded the same way, from the same constant, so
      // a forgotten tab cannot hold segments open forever. Same-mount restarts
      // of the clock are acceptable here for the same reason they are on the
      // poll path: the effect keys deliberately exclude `state`.
      const ceiling = setTimeout(() => abort.abort(), DEPLOYMENT_FOLLOW_CEILING_MS);
      void (async () => {
        const { followPodLifecycle } = await import("@/lib/streaming/pod-lifecycle-client");
        setFollowing(true);
        try {
          await followPodLifecycle({
            cursor: 0,
            // History is the snapshot's job. Without this, every mount replays
            // the retained narrative as live transitions -- a settled journey
            // resurrects its own deployment card and drags the chip backwards
            // through states the person already lived.
            fromHead: true,
            signal: abort.signal,
            onFrame: (frame) => {
              if (cancelled || !frame.state) return;
              const raw = String(frame.state);
              if (!VALID.includes(raw)) return;
              if (frame.hushhId) setHushhId(frame.hushhId);
              if (frame.health) setHealth(frame.health);
              if (raw !== previousRef.current) {
                const deployment = raw as AgentDeploymentState;
                setState(deployment);
                previousRef.current = raw;
                reportBackgroundTask(userId, deployment);
                dispatchFeedStateChanged();
              }
              // A snapshot of a journey that is not in flight is the whole
              // answer: there is nothing to follow. Streaming segments for a
              // settled agent would hold connections open to report that
              // nothing is happening.
              if (frame.event === "snapshot" && !isDeploymentInFlight(raw)) {
                abort.abort();
              }
            },
          });
        } finally {
          if (!cancelled) setFollowing(false);
        }
      })();
      return () => {
        cancelled = true;
        clearTimeout(ceiling);
        abort.abort();
      };
    }

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

  return { state, following, hushhId, health, cloud, deploymentTarget };
}

export { DEPLOYMENT_POLL_INTERVAL_MS };

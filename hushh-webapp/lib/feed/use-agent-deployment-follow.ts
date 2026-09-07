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
/**
 * The software-update half of the status, as the app reads it.
 *
 * `available: null` means the hub could not say (no lane target, nothing
 * recorded) and is different from `false`, which is a positive "current".
 */
export type AgentUpdateStatus = {
  available: boolean | null;
  inProgress: boolean;
  failed: boolean;
  error: string | null;
  running: string | null;
  target: string | null;
};

export const NO_UPDATE: AgentUpdateStatus = {
  available: null,
  inProgress: false,
  failed: false,
  error: null,
  running: null,
  target: null,
};

export function readUpdateStatus(
  res:
    | {
        runningImage?: string | null;
        targetImage?: string | null;
        updateAvailable?: boolean;
        updateInProgress?: boolean;
        updateFailed?: boolean;
        updateError?: string | null;
      }
    | null
    | undefined,
): AgentUpdateStatus {
  return {
    available: typeof res?.updateAvailable === "boolean" ? res.updateAvailable : null,
    inProgress: res?.updateInProgress === true,
    failed: res?.updateFailed === true,
    error: res?.updateError ? String(res.updateError) : null,
    running: res?.runningImage ? String(res.runningImage) : null,
    target: res?.targetImage ? String(res.targetImage) : null,
  };
}

export function updateTaskId(userId: string): string {
  return `${deploymentTaskId(userId)}:update`;
}

/**
 * The update as a background task on the same "Private agent" rail: started when
 * the hub reports it in flight, completed or failed when it stops. Silent while
 * nothing is moving, so a current pod files no card at all.
 */
function reportUpdateTask(
  userId: string | null,
  update: AgentUpdateStatus,
  wasInProgress: boolean,
): void {
  if (!userId) return;
  const taskId = updateTaskId(userId);
  const target = update.target ? ` (${update.target})` : "";
  try {
    if (update.inProgress) {
      AppBackgroundTaskService.startTask({
        userId,
        taskId,
        kind: DEPLOYMENT_TASK_KIND,
        title: "Updating your private agent",
        description: `A newer build is being installed${target}. Your agent keeps answering meanwhile.`,
        routeHref: "/one/feed",
        visibility: "passive",
        groupLabel: "Private agent",
      });
      return;
    }
    if (!wasInProgress) return;
    if (update.failed) {
      AppBackgroundTaskService.failTask(
        taskId,
        "Update did not finish",
        update.error ?? "Your agent is still running its previous build.",
      );
      return;
    }
    AppBackgroundTaskService.completeTask(taskId, "Your private agent is up to date.");
  } catch {
    // A progress indicator must never break the thing it reports on.
  }
}

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
  /** Whether the status endpoint has returned a verdict at least once.
   *
   * `state === null` is ambiguous on its own -- it is both "we have not looked
   * yet" and "this person has no agent" -- and the chat router read the first as
   * the second, so a fast typer's opening message went to the shared hub while
   * their own pod sat idle. With this, a caller can wait for the answer instead
   * of assuming one. */
  resolved: boolean;
  /** The software-update half of the status; `NO_UPDATE` until the endpoint answers. */
  update: AgentUpdateStatus;
} {
  const enabled = options?.enabled ?? true;
  const userId = options?.userId ?? null;
  const [state, setState] = useState<AgentDeploymentState | null>(null);
  // Has the status endpoint answered even once? `state === null` cannot say: it is
  // both "we have not looked yet" and "this person has no agent", and the chat
  // router treated the first as the second and sent their turn to the shared hub.
  const [resolved, setResolved] = useState(false);
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
  const [update, setUpdate] = useState<AgentUpdateStatus>(NO_UPDATE);
  const updateInProgressRef = useRef(false);
  // An update in flight keeps the poll alive past the terminal state, so the
  // chip can go available -> updating -> current without a reload.
  const updateMovingRef = useRef(false);
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
          // The endpoint answered. From here `state === null` means "no agent",
          // not "not looked yet", and the chat router may act on it.
          setResolved(true);
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
          const nextUpdate = readUpdateStatus(res);
          setUpdate(nextUpdate);
          reportUpdateTask(userId, nextUpdate, updateInProgressRef.current);
          updateInProgressRef.current = nextUpdate.inProgress;
          updateMovingRef.current = nextUpdate.inProgress || nextUpdate.available === true;
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
            // A persistent failure is a verdict too: stop holding the router.
            setResolved(true);
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
        updateMoving: updateMovingRef.current,
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

  return { state, following, hushhId, health, cloud, deploymentTarget, resolved, update };
}

export { DEPLOYMENT_POLL_INTERVAL_MS };

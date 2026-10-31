/**
 * Which commit UAT should move to next.
 *
 * The rule this exists to enforce: **deploy the newest eligible green SHA, never
 * "latest main".** A branch is a moving pointer; a deployment target must not be.
 *
 * The incident that produced it: a merge SHA was green, a teammate merged after
 * it, and the deploy was dispatched against the branch tip instead of a
 * validated commit. The tip's own post-merge gate had not finished, so the
 * deploy gate refused it and UAT stayed on an older build — the right outcome,
 * reached by luck rather than by design. Nothing had *selected* a target; a
 * human had guessed one, and the guess happened to be a commit that was not yet
 * proven.
 *
 * `deploy-uat.yml` still contains that shape today: a blank `sha` input resolves
 * to `git rev-parse origin/main`. This module replaces the guess with a
 * decision.
 *
 * Deliberately pure. It takes the state someone else gathered and returns a
 * verdict, so every rule below is testable without a network, a clone, or a
 * cloud project — and so the stale-candidate table is pinned by tests rather
 * than living in a runbook nobody re-reads.
 */

/**
 * @typedef {Object} Candidate
 * @property {string} sha            Full 40-character commit SHA.
 * @property {"success"|"failure"|"pending"|"absent"|"unknown"} gate
 *   The conclusion of that commit's OWN post-merge gate. `absent` means no such
 *   check exists for it, which is normal for non-merge commits carried in by a
 *   merge — they are not deployment targets in their own right.
 */

/**
 * @typedef {Object} ReconcileInput
 * @property {string} mainTipSha
 * @property {string|null} uatActualSha     Currently verified on UAT.
 * @property {string|null} uatDeployingSha  In-flight target, or null.
 * @property {Candidate[]} candidates       Commits after uatActualSha, NEWEST FIRST.
 */

/**
 * @typedef {Object} ReconcileResult
 * @property {"DEPLOY_EXACT_SHA"|"NO_OP"|"AUTOMATIC_WAIT"|"BLOCKED"|"DEPLOY_IN_FLIGHT"} decision
 * @property {string|null} targetSha
 * @property {string} reason
 * @property {string|null} blockedAtSha   The newest commit whose own gate failed.
 */

const GREEN = "success";

/**
 * Decide the next UAT move.
 *
 * Order matters and encodes the policy:
 *
 * 1. An active deployment is never retargeted or cancelled just because `main`
 *    moved. Finish it, then reconcile again.
 * 2. The newest **green** candidate wins. A newer commit that is pending,
 *    queued, failed or unknown may never be substituted for it — and equally,
 *    a newer pending commit does not make an older green one stale.
 * 3. A failed gate blocks that commit only. It is reported so the branch's
 *    health is visible, but it never blocks an older green ancestor from
 *    deploying, and it never gets deployed itself.
 *
 * @param {ReconcileInput} input
 * @returns {ReconcileResult}
 */
export function reconcileUatTarget(input) {
  const { uatActualSha, uatDeployingSha, candidates } = input;

  if (uatDeployingSha) {
    return {
      decision: "DEPLOY_IN_FLIGHT",
      targetSha: null,
      reason: `A UAT deployment of ${short(uatDeployingSha)} is already running; it is never cancelled or retargeted because main moved.`,
      blockedAtSha: null,
    };
  }

  if (!candidates.length) {
    return {
      decision: "NO_OP",
      targetSha: null,
      reason: uatActualSha
        ? `UAT already runs ${short(uatActualSha)} and no newer commit exists.`
        : "No candidate commits and no known UAT state.",
      blockedAtSha: null,
    };
  }

  // Newest green wins. Scanning newest-first means a newer green commit
  // supersedes an older one automatically, which is what makes a queued
  // candidate safe to coalesce.
  const target = candidates.find((c) => c.gate === GREEN) ?? null;

  // Reported for visibility only. A failure never blocks an older green
  // ancestor — the ancestor is proven on its own gate, not on its descendant's.
  const failed = candidates.find((c) => c.gate === "failure") ?? null;

  if (target) {
    return {
      decision: "DEPLOY_EXACT_SHA",
      targetSha: target.sha,
      reason: failed
        ? `${short(target.sha)} is the newest commit with its own successful gate; main is separately blocked at ${short(failed.sha)}.`
        : `${short(target.sha)} is the newest commit with its own successful gate.`,
      blockedAtSha: failed ? failed.sha : null,
    };
  }

  if (failed) {
    return {
      decision: "BLOCKED",
      targetSha: null,
      reason: `No candidate has a successful gate and main is blocked at ${short(failed.sha)}; UAT stays on ${short(uatActualSha)}.`,
      blockedAtSha: failed.sha,
    };
  }

  return {
    decision: "AUTOMATIC_WAIT",
    targetSha: null,
    reason: `No candidate has finished its gate yet; UAT stays on ${short(uatActualSha)} until one does.`,
    blockedAtSha: null,
  };
}

/**
 * Is a specific, already-chosen target still safe to deploy?
 *
 * Run immediately before mutating UAT, and again for any manually supplied SHA.
 * A manual target is a request, not a permission: it must clear the same bar as
 * one the reconciler picked.
 *
 * @param {Object} params
 * @param {string} params.targetSha
 * @param {string|null} params.uatActualSha
 * @param {"success"|"failure"|"pending"|"absent"|"unknown"} params.targetGate
 * @param {boolean} params.reachableFromMain
 * @param {boolean} params.descendsFromUatActual
 * @returns {{ ok: boolean, reason: string }}
 */
export function assertDeployable(params) {
  const {
    targetSha,
    uatActualSha,
    targetGate,
    reachableFromMain,
    descendsFromUatActual,
  } = params;

  if (!/^[0-9a-f]{40}$/.test(String(targetSha || ""))) {
    return {
      ok: false,
      reason: `Target must be a full 40-character commit SHA, never a branch name. Got: ${targetSha || "(empty)"}`,
    };
  }
  if (!reachableFromMain) {
    return { ok: false, reason: `${short(targetSha)} is not reachable from protected main.` };
  }
  if (targetGate !== GREEN) {
    return {
      ok: false,
      reason: `${short(targetSha)} has no successful gate of its own (observed: ${targetGate}).`,
    };
  }
  if (uatActualSha && targetSha === uatActualSha) {
    return { ok: false, reason: `${short(targetSha)} is already live on UAT.` };
  }
  // Forward-only. Redeploying an ancestor would silently roll teammates' merged
  // work out of UAT, which is the failure this whole module exists to avoid.
  if (uatActualSha && !descendsFromUatActual) {
    return {
      ok: false,
      reason: `${short(targetSha)} does not descend from the live UAT commit ${short(uatActualSha)}; UAT never moves backward automatically.`,
    };
  }
  return { ok: true, reason: `${short(targetSha)} is eligible.` };
}

/**
 * Did the thing we deployed actually end up running?
 *
 * A 200 from a health endpoint proves a server answered, not which build
 * answered. Release identity is a separate assertion, and conflating the two is
 * how a stale rollout or a mutable tag passes for a release.
 *
 * @param {Object} params
 * @param {string} params.targetSha
 * @param {string|null} params.runtimeSha
 * @param {boolean} params.smokePassed
 * @returns {{ ok: boolean, reason: string }}
 */
export function assertRuntimeIdentity(params) {
  const { targetSha, runtimeSha, smokePassed } = params;
  if (!smokePassed) {
    return { ok: false, reason: "Post-deploy smoke checks did not pass." };
  }
  if (!runtimeSha) {
    return {
      ok: false,
      reason: "The running service did not report a commit SHA, so its release identity is unproven.",
    };
  }
  if (runtimeSha !== targetSha) {
    return {
      ok: false,
      reason: `Runtime reports ${short(runtimeSha)} but ${short(targetSha)} was deployed; treat as failed and investigate tagging or rollout.`,
    };
  }
  return { ok: true, reason: `Runtime confirms ${short(targetSha)}.` };
}

function short(sha) {
  return sha ? String(sha).slice(0, 12) : "none";
}

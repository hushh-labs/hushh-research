// The UAT deployment selector.
//
// Every case below is one row of the agreed stale-candidate policy. They are
// tests rather than a runbook because the rule that was broken in the real
// incident - "deploy the newest eligible green SHA, never latest main" - is
// exactly the kind of rule that reads as obvious and gets violated under time
// pressure by someone typing a SHA by hand.

import { describe, expect, it } from "vitest";

import {
  assertDeployable,
  assertRuntimeIdentity,
  reconcileUatTarget,
} from "@/scripts/ci/uat-target-selection.mjs";

const A = "a".repeat(40); // older
const B = "b".repeat(40); // newer
const LIVE = "c".repeat(40); // what UAT runs now

const base = {
  mainTipSha: B,
  uatActualSha: LIVE,
  uatDeployingSha: null,
  candidates: [],
};

describe("the stale-candidate policy", () => {
  it("A is green, newer B is pending -> deploy A, never B", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "pending" },
        { sha: A, gate: "success" },
      ],
    });
    // The exact substitution that caused the incident: a pending tip must never
    // stand in for a proven ancestor.
    expect(result.decision).toBe("DEPLOY_EXACT_SHA");
    expect(result.targetSha).toBe(A);
  });

  it("A is green and B becomes green first -> deploy B, coalescing A", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "success" },
        { sha: A, gate: "success" },
      ],
    });
    // B contains A and has its own gate, so the older queued candidate is
    // safely superseded rather than deployed twice.
    expect(result.targetSha).toBe(B);
  });

  it("a deployment is already running -> never cancel or retarget it", () => {
    const result = reconcileUatTarget({
      ...base,
      uatDeployingSha: A,
      candidates: [{ sha: B, gate: "success" }],
    });
    expect(result.decision).toBe("DEPLOY_IN_FLIGHT");
    expect(result.targetSha).toBeNull();
    expect(result.reason).toMatch(/never cancelled or retargeted/i);
  });

  it("A is green and newer B failed -> deploy A, and report main blocked at B", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "failure" },
        { sha: A, gate: "success" },
      ],
    });
    // A failure downstream says nothing about A, which passed its own gate.
    expect(result.decision).toBe("DEPLOY_EXACT_SHA");
    expect(result.targetSha).toBe(A);
    expect(result.blockedAtSha).toBe(B);
  });

  it("nothing green yet -> wait, and leave UAT alone", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "pending" },
        { sha: A, gate: "pending" },
      ],
    });
    expect(result.decision).toBe("AUTOMATIC_WAIT");
    expect(result.targetSha).toBeNull();
  });

  it("everything failed -> blocked, and UAT stays put", () => {
    const result = reconcileUatTarget({
      ...base,
      candidates: [{ sha: B, gate: "failure" }],
    });
    expect(result.decision).toBe("BLOCKED");
    expect(result.targetSha).toBeNull();
    expect(result.blockedAtSha).toBe(B);
  });

  it("no candidates -> no move", () => {
    expect(reconcileUatTarget({ ...base, candidates: [] }).decision).toBe("NO_OP");
  });

  it("ignores a commit that has no gate of its own", () => {
    // Non-merge commits carried in by a merge get no post-merge gate. Treating
    // `absent` as deployable would ship an unproven commit; the live
    // reconciliation run hit exactly this case.
    const result = reconcileUatTarget({
      ...base,
      candidates: [
        { sha: B, gate: "absent" },
        { sha: A, gate: "success" },
      ],
    });
    expect(result.targetSha).toBe(A);
  });
});

describe("the pre-deploy gate", () => {
  const ok = {
    targetSha: B,
    uatActualSha: LIVE,
    targetGate: "success" as const,
    reachableFromMain: true,
    descendsFromUatActual: true,
  };

  it("accepts a proven, forward-moving, exact SHA", () => {
    expect(assertDeployable(ok).ok).toBe(true);
  });

  it("refuses a branch name", () => {
    // "Never deploy a branch name" has to be enforced, not documented: the
    // existing workflow resolves a blank input to `git rev-parse origin/main`.
    for (const bad of ["main", "origin/main", "HEAD", "", "abc123"]) {
      const result = assertDeployable({ ...ok, targetSha: bad });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/full 40-character commit SHA/i);
    }
  });

  it("refuses a commit whose own gate is not green", () => {
    for (const gate of ["pending", "failure", "absent", "unknown"] as const) {
      expect(assertDeployable({ ...ok, targetGate: gate }).ok).toBe(false);
    }
  });

  it("refuses a commit that is not on protected main", () => {
    expect(assertDeployable({ ...ok, reachableFromMain: false }).ok).toBe(false);
  });

  it("refuses to move UAT backward", () => {
    // Redeploying an ancestor would roll teammates' merged work out of UAT
    // while every check still looked green.
    const result = assertDeployable({ ...ok, descendsFromUatActual: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/never moves backward/i);
  });

  it("treats a redeploy of the live commit as a no-op", () => {
    expect(assertDeployable({ ...ok, targetSha: LIVE }).ok).toBe(false);
  });

  it("holds a manual target to the same bar as a selected one", () => {
    // A hand-typed SHA is a request, not a permission - the incident began with
    // exactly such a request.
    expect(
      assertDeployable({ ...ok, targetSha: B, targetGate: "pending" }).ok,
    ).toBe(false);
  });
});

describe("proving what actually ended up running", () => {
  it("accepts only when smoke passed AND the runtime reports the target", () => {
    expect(
      assertRuntimeIdentity({ targetSha: B, runtimeSha: B, smokePassed: true }).ok,
    ).toBe(true);
  });

  it("rejects a green smoke check with the wrong build live", () => {
    // HTTP 200 proves a server answered, not which build answered. This is the
    // stale-rollout and mutable-tag failure mode.
    const result = assertRuntimeIdentity({
      targetSha: B,
      runtimeSha: A,
      smokePassed: true,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/investigate tagging or rollout/i);
  });

  it("rejects a runtime that cannot say what it is", () => {
    expect(
      assertRuntimeIdentity({ targetSha: B, runtimeSha: null, smokePassed: true }).ok,
    ).toBe(false);
  });

  it("rejects a failed smoke check even when identity matches", () => {
    expect(
      assertRuntimeIdentity({ targetSha: B, runtimeSha: B, smokePassed: false }).ok,
    ).toBe(false);
  });
});

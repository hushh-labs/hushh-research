import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_FOLLOW_CEILING_MS,
  DEPLOYMENT_POLL_INTERVAL_MS,
  decideFollow,
  isDeploymentInFlight,
  isDeploymentTerminal,
} from "@/lib/feed/deployment-progress-policy";

/**
 * The Feed loads once on mount and deliberately does not force-refresh, so
 * unread styling stays stable while you read. Correct for an ordinary feed,
 * wrong for the two minutes when the thing you are waiting for is being built:
 * the backend writes a row at every deployment transition and the list never
 * went back to look.
 *
 * These pin the narrow exception — follow only while in flight, refresh only on
 * a real change, and always stop.
 */

describe("deployment progress follow policy", () => {
  it("follows while the agent is still being built", () => {
    for (const state of ["reserved", "provisioning", "connecting"]) {
      expect(isDeploymentInFlight(state)).toBe(true);
      expect(decideFollow({ state, previousState: state, elapsedMs: 0 }).follow).toBe(true);
    }
  });

  it("stops once the deployment settles, either way", () => {
    for (const state of ["active", "failed"]) {
      expect(isDeploymentTerminal(state)).toBe(true);
      expect(decideFollow({ state, previousState: state, elapsedMs: 0 }).follow).toBe(false);
    }
  });

  it("refreshes on a transition, not on every poll", () => {
    // The distinction the whole design rests on. Refreshing every poll would
    // reintroduce the mid-visit churn the no-force-refresh rule prevents.
    const unchanged = decideFollow({
      state: "provisioning",
      previousState: "provisioning",
      elapsedMs: 1000,
    });
    expect(unchanged.refresh).toBe(false);
    expect(unchanged.follow).toBe(true);

    const advanced = decideFollow({
      state: "connecting",
      previousState: "provisioning",
      elapsedMs: 1000,
    });
    expect(advanced.refresh).toBe(true);
    expect(advanced.reason).toBe("advanced");
  });

  it("refreshes once when it settles, so the final row lands", () => {
    const settled = decideFollow({
      state: "active",
      previousState: "connecting",
      elapsedMs: 30_000,
    });
    expect(settled.refresh).toBe(true);
    expect(settled.follow).toBe(false);
    expect(settled.reason).toBe("settled");
  });

  it("does not keep refreshing after it has settled", () => {
    const after = decideFollow({ state: "active", previousState: "active", elapsedMs: 60_000 });
    expect(after.refresh).toBe(false);
    expect(after.follow).toBe(false);
  });

  it("never follows when there is no deployment", () => {
    for (const state of [null, undefined, "", "unknown_state"]) {
      const decision = decideFollow({ state, previousState: null, elapsedMs: 0 });
      expect(decision.follow).toBe(false);
      expect(decision.reason).toBe("idle");
    }
  });

  it("stops at the ceiling rather than polling forever", () => {
    // A stuck deployment must cost a bounded number of requests. This is what
    // makes arming the follow automatically safe.
    const stuck = decideFollow({
      state: "provisioning",
      previousState: "provisioning",
      elapsedMs: DEPLOYMENT_FOLLOW_CEILING_MS,
    });
    expect(stuck.follow).toBe(false);
    expect(stuck.reason).toBe("ceiling_reached");
  });

  it("does not invent a failure when it gives up", () => {
    // The backend owns the failed verdict. A client inventing one is how a UI
    // starts disagreeing with the system it is describing.
    const stuck = decideFollow({
      state: "connecting",
      previousState: "connecting",
      elapsedMs: DEPLOYMENT_FOLLOW_CEILING_MS + 1,
    });
    expect(stuck.reason).not.toContain("fail");
    expect(stuck.refresh).toBe(false);
  });

  it("treats reserved as live, because it is also the fail-safe state", () => {
    // `reserved` is what the backend reports for a missing row or an
    // unrecognised status. Treating it as idle would leave a person whose
    // provisioning stalled with a Feed that decided nothing was happening.
    expect(isDeploymentInFlight("reserved")).toBe(true);
  });

  it("polls far faster than the badge, which cannot see a whole deployment", () => {
    // The unread badge polls at 45s; a deployment can start and finish inside
    // one of those intervals.
    expect(DEPLOYMENT_POLL_INTERVAL_MS).toBeLessThan(45_000 / 4);
  });
});

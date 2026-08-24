/**
 * Presence predicates decide what a person is told about their own agent, and now also
 * whether the client spends a wake on it. `shouldWakePod` is the gate in front of a
 * network side effect on a shared, costed fleet, so every branch is pinned here: an
 * inversion that woke a healthy pod, or that woke on the fault path instead of routing
 * to recovery, or that woke a pod that does not exist yet, turns this red.
 */

import { describe, expect, it } from "vitest";

import {
  isAgentAsleep,
  isAgentNotAnswering,
  shouldWakePod,
} from "@/lib/feed/agent-presence-policy";

describe("isAgentNotAnswering / isAgentAsleep", () => {
  it("treats sleeping as asleep, never as not-answering", () => {
    expect(isAgentAsleep("sleeping")).toBe(true);
    expect(isAgentNotAnswering("sleeping")).toBe(false);
  });

  it("treats degraded/unreachable as not-answering, never as asleep", () => {
    for (const h of ["degraded", "unreachable"]) {
      expect(isAgentNotAnswering(h)).toBe(true);
      expect(isAgentAsleep(h)).toBe(false);
    }
  });

  it("says nothing for unknown or absent health", () => {
    for (const h of ["unknown", null, undefined, "healthy"]) {
      expect(isAgentNotAnswering(h)).toBe(false);
      expect(isAgentAsleep(h)).toBe(false);
    }
  });
});

describe("shouldWakePod", () => {
  it("wakes an active pod that is asleep, unknown, or has no reported health", () => {
    for (const h of ["sleeping", "unknown", null, undefined]) {
      expect(shouldWakePod("active", h)).toBe(true);
    }
  });

  it("does not wake a pod that is already healthy (warm)", () => {
    expect(shouldWakePod("active", "healthy")).toBe(false);
  });

  it("does not wake on the fault path -- that is recovery's job, not wake's", () => {
    expect(shouldWakePod("active", "degraded")).toBe(false);
    expect(shouldWakePod("active", "unreachable")).toBe(false);
  });

  it("never wakes a pod that is not live yet -- there is nothing to wake", () => {
    for (const s of ["reserved", "provisioning", "connecting", "failed", null, undefined]) {
      expect(shouldWakePod(s, "sleeping")).toBe(false);
      expect(shouldWakePod(s, null)).toBe(false);
    }
  });
});

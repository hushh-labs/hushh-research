/**
 * classifyAgentRecovery is the one place that decides whether a returning user's agent
 * is reconnected, adopted, sent to re-authorize, or (last resort) rebuilt with a new
 * identity. The north-star rule it enforces: preserve identity + memory unless the pod
 * is provably gone AND the cloud is reachable. These pin every branch so an inversion
 * — a swallowed adopt result, a flipped needsFreshSetup check — turns red.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above const declarations, so the spies must be too.
const { getPodInfo, wakePod, adoptOrphanPod } = vi.hoisted(() => ({
  getPodInfo: vi.fn(),
  wakePod: vi.fn(),
  adoptOrphanPod: vi.fn(),
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { getPodInfo, wakePod, adoptOrphanPod },
}));

import { classifyAgentRecovery } from "@/lib/feed/agent-recovery";

beforeEach(() => {
  getPodInfo.mockReset();
  wakePod.mockReset();
  adoptOrphanPod.mockReset();
});

describe("classifyAgentRecovery", () => {
  it("reconnects on the fast path when a known pod answers", async () => {
    getPodInfo.mockResolvedValue({ podStatus: 200 });
    const out = await classifyAgentRecovery({ podHushhId: "ha1_abc" });
    expect(out).toEqual({ kind: "reconnected" });
    expect(wakePod).not.toHaveBeenCalled();
  });

  it("reconnects when the wake probe reports awake", async () => {
    wakePod.mockResolvedValue({ state: "awake", etaMs: 0 });
    expect(await classifyAgentRecovery({})).toEqual({ kind: "reconnected" });
  });

  it("waits when the wake probe reports waking", async () => {
    wakePod.mockResolvedValue({ state: "waking", etaMs: 12000 });
    expect(await classifyAgentRecovery({})).toEqual({ kind: "waking", etaMs: 12000 });
  });

  it("adopts a gone pod that is still recoverable -> reconnected", async () => {
    wakePod.mockResolvedValue({ state: "gone", etaMs: 0, needsFreshSetup: false });
    adoptOrphanPod.mockResolvedValue({ adopted: true, status: "provisioned" });
    expect(await classifyAgentRecovery({})).toEqual({ kind: "reconnected" });
  });

  it("treats an adopted-but-warming pod as waking, not reconnected", async () => {
    wakePod.mockResolvedValue({ state: "gone", etaMs: 12000, needsFreshSetup: false });
    adoptOrphanPod.mockResolvedValue({ adopted: true, status: "connecting" });
    expect(await classifyAgentRecovery({})).toEqual({ kind: "waking", etaMs: 12000 });
  });

  it("routes to reinit when the project is gone and nothing is adoptable", async () => {
    wakePod.mockResolvedValue({ state: "gone", etaMs: 0, needsFreshSetup: true });
    adoptOrphanPod.mockResolvedValue({ adopted: false });
    expect(await classifyAgentRecovery({})).toEqual({ kind: "needs_reinit" });
  });

  it("only offers a rebuild when gone, reachable, and nothing was adoptable", async () => {
    wakePod.mockResolvedValue({ state: "gone", etaMs: 0, needsFreshSetup: false });
    adoptOrphanPod.mockResolvedValue({ adopted: false });
    expect(await classifyAgentRecovery({})).toEqual({ kind: "rebuildable" });
  });

  it("falls through to reinit/rebuild when the adopt call itself fails", async () => {
    wakePod.mockResolvedValue({ state: "gone", etaMs: 0, needsFreshSetup: true });
    adoptOrphanPod.mockRejectedValue(new Error("network"));
    expect(await classifyAgentRecovery({})).toEqual({ kind: "needs_reinit" });
  });

  it("reports an error when the whole probe throws", async () => {
    wakePod.mockRejectedValue(new Error("boom"));
    const out = await classifyAgentRecovery({});
    expect(out.kind).toBe("error");
  });
});

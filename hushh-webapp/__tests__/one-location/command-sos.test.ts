import { describe, expect, it, vi } from "vitest";
import {
  SosOperationGate,
  stopSosShares,
} from "@/lib/one-location/command-sos";

describe("SOS stop service outcomes", () => {
  it("holds the SOS operation lease through a delayed revoke and isolates a new owner", async () => {
    const gate = new SosOperationGate();
    const old = gate.begin("owner-a")!;
    let complete!: () => void;
    const stopped = stopSosShares({
      grantIds: ["old"],
      revoke: async (id) => {
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
        return { id, status: "revoked" };
      },
    });
    // An incident can disappear from a state refresh before its response arrives.
    expect(gate.begin("owner-a")).toBeNull();
    const next = gate.begin("owner-b")!;
    complete();
    await stopped;
    expect(gate.finish("owner-a", old)).toBe(false);
    expect(gate.begin("owner-b")).toBeNull();
    expect(gate.finish("owner-b", next)).toBe(true);
    expect(gate.begin("owner-b")).not.toBeNull();
  });
  it("retains every unresolved grant and continues revoking the others", async () => {
    const revoke = vi.fn(async (id: string) => {
      if (id === "lost") throw Error("response lost");
      return { id, status: id === "still-live" ? "active" : "revoked" };
    });
    const result = await stopSosShares({
      grantIds: ["revoked", "lost", "still-live", "last", "last"],
      revoke,
    });
    expect(result).toEqual({
      revoked: ["revoked", "last"],
      unresolved: ["lost", "still-live"],
    });
    expect(revoke).toHaveBeenCalledTimes(4);
  });
  it("requires a correlated terminal result and does not dispatch after cancellation", async () => {
    const revoke = vi.fn(async () => ({
      id: "other-incident",
      status: "revoked",
    }));
    expect(await stopSosShares({ grantIds: ["a"], revoke })).toEqual({
      revoked: [],
      unresolved: ["a"],
    });
    const signal = AbortSignal.abort();
    expect(
      await stopSosShares({ grantIds: ["b", "c"], revoke, signal }),
    ).toEqual({ revoked: [], unresolved: ["b", "c"] });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

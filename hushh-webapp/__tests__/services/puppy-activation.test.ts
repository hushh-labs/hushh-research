import { afterEach, describe, expect, it, vi } from "vitest";
import { activatePuppyWhenIdle } from "@/lib/services/pod-activation";

describe("Puppy activation after owner grant restoration", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for fresh device admission while the old pod subject is revoked", async () => {
    vi.useFakeTimers();
    const status = vi.fn()
      .mockResolvedValueOnce({ inference_ready: false, state: "revoked" })
      .mockResolvedValueOnce({ inference_ready: false, state: "revoked" })
      .mockResolvedValueOnce({ inference_ready: true, state: "ready" });
    const hub = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const activation = activatePuppyWhenIdle("tdv_mac_1", "synthetic-owner", undefined, { status, hub });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(activation).resolves.toBeUndefined();
    expect(hub).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(3);
  });

  it("still refuses when the hub rejects the owner grant", async () => {
    const status = vi.fn().mockResolvedValue({ inference_ready: false, state: "revoked" });
    const hub = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    await expect(activatePuppyWhenIdle("tdv_mac_1", "synthetic-owner", undefined, { status, hub }))
      .rejects.toThrow("PUPPY_ACTIVATION_UNAVAILABLE:403");
    expect(status).toHaveBeenCalledTimes(1);
  });
});

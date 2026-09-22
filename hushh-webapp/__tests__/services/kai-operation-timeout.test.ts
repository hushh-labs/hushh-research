import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runKaiStepWithTimeout } from "@/lib/kai/brokerage/kai-operation-timeout";

describe("runKaiStepWithTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns a completed step and clears its timer", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(
      runKaiStepWithTimeout("Saving portfolio", Promise.resolve("saved"), 1000),
    ).resolves.toBe("saved");

    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("rejects with the step name when a step exceeds its deadline", async () => {
    const pending = runKaiStepWithTimeout(
      "Updating source preference",
      new Promise(() => undefined),
      1000,
    );
    const captured = pending.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(captured).resolves.toMatchObject({
      message: expect.stringContaining("Updating source preference"),
    });
  });
});

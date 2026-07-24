import { describe, expect, it, vi } from "vitest";

import { retryAsync } from "@/lib/utils/retry";

describe("retryAsync", () => {
  it("returns the first successful result without delay", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const delay = vi.fn();

    await expect(retryAsync(operation, { delay })).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("retries retryable failures before succeeding", async () => {
    const retryable = new Error("temporary");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(retryable)
      .mockResolvedValueOnce("ok");
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryAsync(operation, {
        retries: 2,
        delayMs: 25,
        delay,
        shouldRetry: (error) => error === retryable,
      })
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(25);
  });

  it("does not retry non-retryable failures", async () => {
    const error = new Error("bad request");
    const operation = vi.fn().mockRejectedValue(error);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryAsync(operation, {
        retries: 2,
        delay,
        shouldRetry: () => false,
      })
    ).rejects.toThrow("bad request");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("stops after max attempts", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("still down"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      retryAsync(operation, {
        retries: 2,
        delay,
        shouldRetry: () => true,
      })
    ).rejects.toThrow("still down");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });
});

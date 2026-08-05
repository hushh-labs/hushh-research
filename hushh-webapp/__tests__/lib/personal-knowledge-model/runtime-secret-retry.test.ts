import { describe, it, expect, vi } from "vitest";
import {
  classifyRuntimeSecretStoreError,
  computeRuntimeSecretRetryDelayMs,
  runRuntimeSecretCommitWithRetry,
  RuntimeSecretCommitError,
  RUNTIME_SECRET_MAX_ATTEMPTS,
  RUNTIME_SECRET_RETRY_BASE_MS,
  RUNTIME_SECRET_RETRY_MAX_DELAY_MS,
  type RuntimeSecretCommitHooks,
} from "@/lib/personal-knowledge-model/runtime-secret-retry";

type Result = { success: boolean; conflict?: boolean; message?: string };

/**
 * Build a runner harness with fully controllable hooks. `now` advances by a
 * fixed step on every read so tests can exercise the deadline without real time.
 */
function makeHooks(overrides: Partial<RuntimeSecretCommitHooks<Result>> = {}) {
  const pause = vi.fn(async (_ms: number) => undefined);
  let clock = 0;
  const now = vi.fn(() => {
    const value = clock;
    clock += 1;
    return value;
  });
  const rebuildAfterConflict = vi.fn(async () => undefined);
  const random = vi.fn(() => 0); // deterministic: zero jitter unless overridden
  const hooks: RuntimeSecretCommitHooks<Result> = {
    send: vi.fn(async () => ({ success: true })),
    rebuildAfterConflict,
    pause,
    now,
    random,
    ...overrides,
  };
  return { hooks, pause, rebuildAfterConflict, random, setClock: (fn: () => number) => (hooks.now = fn) };
}

describe("classifyRuntimeSecretStoreError", () => {
  it("treats configured 5xx/429/408/425 store-domain failures as transient", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      const error = new Error(`Failed to store domain data: ${status} - upstream hiccup`);
      expect(classifyRuntimeSecretStoreError(error)).toBe("transient");
    }
  });

  it("treats 4xx client failures and conflicts as fatal (not replayable)", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      const error = new Error(`Failed to store domain data: ${status} - nope`);
      expect(classifyRuntimeSecretStoreError(error)).toBe("fatal");
    }
  });

  it("treats network/abort/timeout fingerprints as transient", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(classifyRuntimeSecretStoreError(abort)).toBe("transient");

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(classifyRuntimeSecretStoreError(timeout)).toBe("transient");

    expect(classifyRuntimeSecretStoreError(new TypeError("Failed to fetch"))).toBe(
      "transient",
    );
    expect(classifyRuntimeSecretStoreError(new Error("NetworkError when attempting to fetch"))).toBe(
      "transient",
    );
    expect(classifyRuntimeSecretStoreError(new Error("socket hang up"))).toBe("transient");
    expect(classifyRuntimeSecretStoreError("Load failed")).toBe("transient");
  });

  it("defaults precondition/unknown errors to fatal", () => {
    expect(classifyRuntimeSecretStoreError(new Error("Invalid PKM credential reference."))).toBe(
      "fatal",
    );
    expect(classifyRuntimeSecretStoreError(new Error("Runtime secret is required."))).toBe("fatal");
    expect(classifyRuntimeSecretStoreError(undefined)).toBe("fatal");
    expect(classifyRuntimeSecretStoreError({ weird: true })).toBe("fatal");
  });
});

describe("computeRuntimeSecretRetryDelayMs", () => {
  it("applies full jitter within the exponential ceiling", () => {
    // random=1 yields the ceiling; random=0 yields 0.
    expect(
      computeRuntimeSecretRetryDelayMs(0, { baseMs: 300, maxMs: 2000, random: () => 1 }),
    ).toBe(300);
    expect(
      computeRuntimeSecretRetryDelayMs(1, { baseMs: 300, maxMs: 2000, random: () => 1 }),
    ).toBe(600);
    expect(
      computeRuntimeSecretRetryDelayMs(2, { baseMs: 300, maxMs: 2000, random: () => 1 }),
    ).toBe(1200);
    expect(
      computeRuntimeSecretRetryDelayMs(0, { baseMs: 300, maxMs: 2000, random: () => 0 }),
    ).toBe(0);
  });

  it("never exceeds maxMs even for large attempt indices", () => {
    const delay = computeRuntimeSecretRetryDelayMs(10, {
      baseMs: 300,
      maxMs: 2000,
      random: () => 1,
    });
    expect(delay).toBe(2000);
  });

  it("clamps negative/fractional indices to a safe floor", () => {
    expect(
      computeRuntimeSecretRetryDelayMs(-5, { baseMs: 300, maxMs: 2000, random: () => 1 }),
    ).toBe(300);
  });

  it("defaults to the module base/max constants", () => {
    const delay = computeRuntimeSecretRetryDelayMs(0, { random: () => 1 });
    expect(delay).toBe(RUNTIME_SECRET_RETRY_BASE_MS);
    expect(delay).toBeLessThanOrEqual(RUNTIME_SECRET_RETRY_MAX_DELAY_MS);
  });
});

describe("runRuntimeSecretCommitWithRetry", () => {
  it("returns immediately on first success without pausing or rebuilding", async () => {
    const { hooks, pause, rebuildAfterConflict } = makeHooks({
      send: vi.fn(async () => ({ success: true, message: "ok" })),
    });
    const result = await runRuntimeSecretCommitWithRetry(hooks);
    expect(result).toEqual({ success: true, message: "ok" });
    expect(hooks.send).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    expect(rebuildAfterConflict).not.toHaveBeenCalled();
  });

  // THE regression test: a transient infra fault must be replayed with the
  // IDENTICAL request (no rebuild) and then succeed — exactly the path that was
  // missing when the "Your choice could not be saved" toast fired.
  it("replays the identical request after a transient throw, then succeeds", async () => {
    const send = vi
      .fn<[], Promise<Result>>()
      .mockRejectedValueOnce(new Error("Failed to store domain data: 503 - overloaded"))
      .mockResolvedValueOnce({ success: true });
    const { hooks, pause, rebuildAfterConflict } = makeHooks({ send });

    const result = await runRuntimeSecretCommitWithRetry(hooks);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(pause).toHaveBeenCalledTimes(1); // backed off once
    expect(rebuildAfterConflict).not.toHaveBeenCalled(); // transient => NO rebuild
  });

  it("gives up after exhausting attempts on persistent transient faults", async () => {
    const send = vi.fn(async () => {
      throw new Error("Failed to store domain data: 500 - still broken");
    });
    const { hooks, pause } = makeHooks({ send, now: () => 0 });

    await expect(runRuntimeSecretCommitWithRetry(hooks)).rejects.toThrow(
      /Failed to store domain data: 500/,
    );
    expect(send).toHaveBeenCalledTimes(RUNTIME_SECRET_MAX_ATTEMPTS);
    expect(pause).toHaveBeenCalledTimes(RUNTIME_SECRET_MAX_ATTEMPTS - 1);
  });

  it("fails fast on a fatal throw (no retry, no pause)", async () => {
    const fatal = new Error("Failed to store domain data: 400 - bad request");
    const send = vi.fn(async () => {
      throw fatal;
    });
    const { hooks, pause } = makeHooks({ send });

    await expect(runRuntimeSecretCommitWithRetry(hooks)).rejects.toBe(fatal);
    expect(send).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("rebuilds after a genuine conflict and then succeeds without backoff", async () => {
    const send = vi
      .fn<[], Promise<Result>>()
      .mockResolvedValueOnce({ success: false, conflict: true, message: "version conflict" })
      .mockResolvedValueOnce({ success: true });
    const { hooks, pause, rebuildAfterConflict } = makeHooks({ send });

    const result = await runRuntimeSecretCommitWithRetry(hooks);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect(rebuildAfterConflict).toHaveBeenCalledTimes(1); // conflict => rebuild
    expect(pause).not.toHaveBeenCalled(); // conflict => no backoff
  });

  it("throws a conflict RuntimeSecretCommitError once rebuilds are exhausted", async () => {
    const send = vi.fn(async () => ({
      success: false,
      conflict: true,
      message: "still conflicting",
    }));
    const { hooks, rebuildAfterConflict } = makeHooks({ send });

    await expect(runRuntimeSecretCommitWithRetry(hooks)).rejects.toMatchObject({
      name: "RuntimeSecretCommitError",
      reason: "conflict",
    });
    expect(send).toHaveBeenCalledTimes(RUNTIME_SECRET_MAX_ATTEMPTS);
    expect(rebuildAfterConflict).toHaveBeenCalledTimes(RUNTIME_SECRET_MAX_ATTEMPTS - 1);
  });

  it("throws a rejected RuntimeSecretCommitError on success:false without conflict", async () => {
    const send = vi.fn(async () => ({ success: false, message: "hard no" }));
    const { hooks, pause, rebuildAfterConflict } = makeHooks({ send });

    const error = await runRuntimeSecretCommitWithRetry(hooks).catch((e) => e);
    expect(error).toBeInstanceOf(RuntimeSecretCommitError);
    expect(error.reason).toBe("rejected");
    expect(send).toHaveBeenCalledTimes(1); // definite rejection, no retry
    expect(pause).not.toHaveBeenCalled();
    expect(rebuildAfterConflict).not.toHaveBeenCalled();
  });

  it("stops retrying transient faults once the wall-clock deadline is exceeded", async () => {
    const send = vi.fn(async () => {
      throw new Error("Failed to store domain data: 503 - overloaded");
    });
    // now() jumps past the deadline immediately after the first failure.
    let calls = 0;
    const now = vi.fn(() => {
      calls += 1;
      return calls === 1 ? 0 : 999_999;
    });
    const { hooks, pause } = makeHooks({ send, now });

    await expect(runRuntimeSecretCommitWithRetry(hooks)).rejects.toThrow(
      /Failed to store domain data: 503/,
    );
    expect(send).toHaveBeenCalledTimes(1); // deadline blocked any replay
    expect(pause).not.toHaveBeenCalled();
  });
});

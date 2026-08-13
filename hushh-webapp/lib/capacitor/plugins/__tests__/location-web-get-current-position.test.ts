/**
 * Acquisition edge cases for `HushhLocationWeb.getCurrentPosition`.
 *
 * This method had no coverage at all, which is how a promise that can never
 * settle reached users: the One Location share controls all await it, so a
 * pending acquisition presented as a button that spun forever with no error
 * and no way back.
 *
 * The load-bearing case is "the browser never calls either callback". Per the
 * W3C Geolocation spec the `timeout` option does not start counting until the
 * permission prompt has been resolved, so a prompt the user never answers — or
 * one the browser suppresses without telling the page — fires neither the
 * success nor the error callback, ever. Every test below that advances timers
 * past a deadline is asserting that WE bound it rather than trusting the
 * browser to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HushhLocationWeb } from "@/lib/capacitor/plugins/location-web";

type SuccessFn = (position: GeolocationPosition) => void;
type ErrorFn = (error: GeolocationPositionError) => void;
type Options = PositionOptions | undefined;

type GetCurrentPositionCall = {
  success: SuccessFn;
  error: ErrorFn;
  options: Options;
};

type WatchCall = GetCurrentPositionCall;

function makePosition(
  accuracy: number | null,
  overrides?: Partial<GeolocationCoordinates>,
): GeolocationPosition {
  return {
    coords: {
      latitude: 19.076,
      longitude: 72.877,
      accuracy: accuracy as number,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      ...overrides,
    },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

function makeError(code: number): GeolocationPositionError {
  return { code, message: `code ${code}` } as GeolocationPositionError;
}

describe("HushhLocationWeb.getCurrentPosition", () => {
  let getCurrentPositionCalls: GetCurrentPositionCall[];
  let watchCalls: WatchCall[];
  let clearWatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    getCurrentPositionCalls = [];
    watchCalls = [];
    clearWatch = vi.fn();

    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (
          success: SuccessFn,
          error: ErrorFn,
          options: Options,
        ) => {
          getCurrentPositionCalls.push({ success, error, options });
        },
        watchPosition: (
          success: SuccessFn,
          error: ErrorFn,
          options: Options,
        ) => {
          watchCalls.push({ success, error, options });
          return watchCalls.length;
        },
        clearWatch,
      },
      permissions: { query: vi.fn().mockRejectedValue(new Error("nope")) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------
  // The regression that let the bug ship.
  // ---------------------------------------------------------------------

  it("rejects when the browser never invokes either callback", async () => {
    // The exact "Share outside your Circle spins forever" shape: an outstanding
    // permission prompt stops the spec's timeout clock, so neither callback is
    // ever called. Before the fix this promise stayed pending for the life of
    // the tab.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 5_000 });
    const settled = vi.fn();
    promise.then(settled, settled);

    // Nothing calls back. Push past every stage's deadline.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toHaveBeenCalled();
    await expect(promise).rejects.toThrow(/Could not get your location/i);
  });

  it("bounds the whole acquisition even when every stage stays silent", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 15_000 });
    promise.catch(() => undefined);

    // timeoutMs (15s) + the 8s overall grace. Nothing may outlive it.
    await vi.advanceTimersByTimeAsync(15_000 + 8_000 + 1_000);

    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it("rejects with an Error instance, never a bare { code } literal", async () => {
    // `locationServicesErrorMessage` and `LocationBus.isDeniedError` both branch
    // on `instanceof Error`; a plain object silently degrades every downstream
    // message the user sees.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 3_000 });
    const captured = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(60_000);

    const error = await captured;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Could not get your location/i);
    // Specifically NOT the shape the timeout path used to reject with.
    expect(Object.prototype.toString.call(error)).toBe("[object Error]");
  });

  it("tags the internal sampling timeout as TIMEOUT so the retry chain runs", async () => {
    // The sampling stage must reject with code 3, not a bare object: the outer
    // handler branches on the code to decide between "denied" (final) and
    // "unavailable/timeout" (retry at low accuracy). A codeless rejection
    // skipped the retry that makes this work on desktops without GPS.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(9_000);

    // Reaching the low-accuracy read at all proves the timeout was classified
    // as retryable rather than falling through to the terminal branch.
    expect(getCurrentPositionCalls).toHaveLength(1);
    expect(getCurrentPositionCalls[0].options?.enableHighAccuracy).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Permission handling.
  // ---------------------------------------------------------------------

  it("treats PERMISSION_DENIED as denial and does not retry", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 5_000 });
    const captured = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    watchCalls[0].error(makeError(1));
    await vi.advanceTimersByTimeAsync(0);

    const error = (await captured) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LocationPermissionDeniedError");
    // A denial is final: no low-accuracy retry, no last-resort cached read.
    expect(getCurrentPositionCalls).toHaveLength(0);
  });

  it("does not abort sampling on a transient POSITION_UNAVAILABLE", async () => {
    // A live provider reports code 2/3 routinely between fixes. Treating either
    // as failure is what made a working device report "location is off".
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(0);
    watchCalls[0].error(makeError(2));
    await vi.advanceTimersByTimeAsync(100);
    watchCalls[0].success(makePosition(12));
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toMatchObject({ accuracyM: 12 });
  });

  // ---------------------------------------------------------------------
  // Accuracy sampling.
  // ---------------------------------------------------------------------

  it("resolves immediately once a fix is accurate enough", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(0);
    watchCalls[0].success(makePosition(20)); // <= 35m target
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toMatchObject({
      latitude: 19.076,
      accuracyM: 20,
      sourcePlatform: "web",
    });
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  it("returns the best sample rather than waiting out the whole budget", async () => {
    // A laptop with no GPS produces one coarse fix and no better one is ever
    // coming. Holding the caller for the full budget is the delay users feel on
    // every control.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(0);
    watchCalls[0].success(makePosition(400));
    await vi.advanceTimersByTimeAsync(200);
    watchCalls[0].success(makePosition(120)); // better, still not confident
    await vi.advanceTimersByTimeAsync(1_200); // refine window closes

    await expect(promise).resolves.toMatchObject({ accuracyM: 120 });
  });

  it("keeps a fix that reports accuracy over one that does not", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(0);
    watchCalls[0].success(makePosition(90));
    await vi.advanceTimersByTimeAsync(100);
    watchCalls[0].success(makePosition(null));
    await vi.advanceTimersByTimeAsync(1_200);

    await expect(promise).resolves.toMatchObject({ accuracyM: 90 });
  });

  // ---------------------------------------------------------------------
  // Fallback chain.
  // ---------------------------------------------------------------------

  it("retries at low accuracy when high-accuracy sampling times out", async () => {
    // Desktops without GPS fail high-accuracy but answer a coarse request.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(9_000); // sampling budget elapses, no fix
    expect(getCurrentPositionCalls).toHaveLength(1);
    expect(getCurrentPositionCalls[0].options?.enableHighAccuracy).toBe(false);

    getCurrentPositionCalls[0].success(makePosition(800));
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toMatchObject({ accuracyM: 800 });
  });

  it("falls back to a recent cached fix before giving up", async () => {
    // "Location is on but sharing says it is off": the provider cannot produce
    // a NEW fix while holding a perfectly good one from seconds ago.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(9_000);
    getCurrentPositionCalls[0].error(makeError(2)); // fresh low-accuracy fails
    await vi.advanceTimersByTimeAsync(0);

    expect(getCurrentPositionCalls).toHaveLength(2);
    const lastResort = getCurrentPositionCalls[1];
    expect(lastResort.options?.maximumAge).toBe(30_000);

    lastResort.success(makePosition(500));
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toMatchObject({ accuracyM: 500 });
  });

  it("still reaches the last-resort read when earlier stages consume time", async () => {
    // Guards the reserve: if the earlier stages were allowed to spend the whole
    // deadline, the cached-fix recovery would never run.
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 15_000 });
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(9_000); // sampling budget
    await vi.advanceTimersByTimeAsync(60_000); // low-accuracy read stays silent

    expect(getCurrentPositionCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      getCurrentPositionCalls.some((call) => call.options?.maximumAge === 30_000),
    ).toBe(true);
  });

  it("surfaces a permission denial discovered during the low-accuracy retry", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });
    const captured = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(9_000);
    getCurrentPositionCalls[0].error(makeError(1));
    await vi.advanceTimersByTimeAsync(0);

    const error = (await captured) as Error;
    expect(error.name).toBe("LocationPermissionDeniedError");
  });

  // ---------------------------------------------------------------------
  // Resource hygiene.
  // ---------------------------------------------------------------------

  it("clears the watch exactly once per acquisition", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });

    await vi.advanceTimersByTimeAsync(0);
    watchCalls[0].success(makePosition(10));
    await vi.advanceTimersByTimeAsync(5_000);

    await promise;
    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  it("clears the watch when sampling times out", async () => {
    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(9_000);

    expect(clearWatch).toHaveBeenCalledTimes(1);
  });

  it("rejects when the browser has no geolocation at all", async () => {
    vi.stubGlobal("navigator", {});
    await expect(new HushhLocationWeb().getCurrentPosition()).rejects.toThrow(
      /unavailable in this browser/i,
    );
  });

  it("survives watchPosition throwing synchronously", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (
          success: SuccessFn,
          error: ErrorFn,
          options: Options,
        ) => {
          getCurrentPositionCalls.push({ success, error, options });
        },
        watchPosition: () => {
          throw new TypeError("watchPosition is not a function");
        },
        clearWatch,
      },
    });

    const web = new HushhLocationWeb();
    const promise = web.getCurrentPosition({ timeoutMs: 9_000 });
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(getCurrentPositionCalls.length).toBeGreaterThanOrEqual(1);

    getCurrentPositionCalls[0].success(makePosition(300));
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toMatchObject({ accuracyM: 300 });
  });
});

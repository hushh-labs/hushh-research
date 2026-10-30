import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformHarness = vi.hoisted(() => ({ native: false }));

vi.mock("@/lib/capacitor/platform", () => ({
  getPlatform: () => (platformHarness.native ? "ios" : "web"),
  isNative: () => platformHarness.native,
}));

import {
  LAYOUT_WAIT_INTERVAL_MS,
  LAYOUT_WAIT_TIMEOUT_MS,
  __resetNativeMapLifecycleForTests,
  claimNativeMap,
  isNativeMapSuperseded,
  waitForLaidOutBox,
  withNativeMapLock,
} from "@/lib/one-location/native-map-lifecycle";

const MAP_ID = "one-location-private-map";
const OTHER_ID = "one-location-onboarding-picker-map";

/** A box that reports whatever dimensions the case wants, when it wants them. */
function stubElement(rect: { width: number; height: number }): HTMLElement {
  return {
    getBoundingClientRect: () => ({ width: rect.width, height: rect.height }),
  } as unknown as HTMLElement;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetNativeMapLifecycleForTests();
  platformHarness.native = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withNativeMapLock", () => {
  it("runs tasks in call order and never overlaps them", async () => {
    const events: string[] = [];
    const first = deferred<void>();
    const second = deferred<void>();

    const a = withNativeMapLock(MAP_ID, async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = withNativeMapLock(MAP_ID, async () => {
      events.push("b:start");
      await second.promise;
      events.push("b:end");
    });

    // B must not have begun while A is still in flight -- overlapping create
    // and destroy on one id is the whole defect.
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);

    first.resolve();
    await a;
    await Promise.resolve();
    expect(events).toEqual(["a:start", "a:end", "b:start"]);

    second.resolve();
    await b;
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("keeps a rejected task from stalling every later task on that id", async () => {
    // Without isolation one failed create would hang the lane forever, and
    // every later entry to Your Map would sit on a spinner that never ends.
    const failed = withNativeMapLock(MAP_ID, async () => {
      throw new Error("create failed");
    });
    await expect(failed).rejects.toThrow("create failed");

    const after = await withNativeMapLock(MAP_ID, async () => "recovered");
    expect(after).toBe("recovered");
  });

  it("still reports a failure to the caller that owns it", async () => {
    const boom = withNativeMapLock(MAP_ID, async () => {
      throw new Error("bridge unavailable");
    });
    await expect(boom).rejects.toThrow("bridge unavailable");
  });

  it("does not let one map id block another", async () => {
    // Your Map and the onboarding picker are separate native maps. A slow or
    // wedged create on one must never delay the other.
    const held = deferred<void>();
    const order: string[] = [];

    void withNativeMapLock(MAP_ID, async () => {
      order.push("map:start");
      await held.promise;
    });
    const other = withNativeMapLock(OTHER_ID, async () => {
      order.push("picker:ran");
      return "picker";
    });

    expect(await other).toBe("picker");
    expect(order).toEqual(["map:start", "picker:ran"]);
    held.resolve();
  });
});

describe("claimNativeMap / isNativeMapSuperseded", () => {
  it("supersedes an earlier claim and leaves the current one live", () => {
    const first = claimNativeMap(MAP_ID);
    expect(isNativeMapSuperseded(MAP_ID, first)).toBe(false);

    const second = claimNativeMap(MAP_ID);
    expect(isNativeMapSuperseded(MAP_ID, first)).toBe(true);
    expect(isNativeMapSuperseded(MAP_ID, second)).toBe(false);
  });

  it("tracks each map id independently", () => {
    const map = claimNativeMap(MAP_ID);
    claimNativeMap(OTHER_ID);
    claimNativeMap(OTHER_ID);
    expect(isNativeMapSuperseded(MAP_ID, map)).toBe(false);
  });
});

describe("waitForLaidOutBox latency", () => {
  it("adds no latency on web", async () => {
    const timer = vi.spyOn(window, "setTimeout");
    await waitForLaidOutBox(stubElement({ width: 0, height: 0 }));
    // Web uses the JS SDK and has no native frame to get wrong, so this must
    // not cost even one scheduler turn.
    expect(timer).not.toHaveBeenCalled();
  });

  it("adds no latency when the container is already laid out", async () => {
    platformHarness.native = true;
    const timer = vi.spyOn(window, "setTimeout");
    await waitForLaidOutBox(stubElement({ width: 390, height: 844 }));
    // The common path: the box is real on the first measurement, so opening
    // Your Map must not wait on a polling interval before create() is issued.
    expect(timer).not.toHaveBeenCalled();
  });

  it("waits for a container that has width but no height yet", async () => {
    platformHarness.native = true;
    vi.useFakeTimers();
    const box = { width: 390, height: 0 };
    let settled = false;

    const wait = waitForLaidOutBox({
      getBoundingClientRect: () => ({ ...box }),
    } as unknown as HTMLElement).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(LAYOUT_WAIT_INTERVAL_MS);
    // The plugin only retries a zero *width*, so this is exactly the shape it
    // would have accepted and baked into the native frame as a zero height.
    expect(settled).toBe(false);

    box.height = 844;
    await vi.advanceTimersByTimeAsync(LAYOUT_WAIT_INTERVAL_MS);
    await wait;
    expect(settled).toBe(true);
  });

  it("gives up within its budget when the container never lays out", async () => {
    platformHarness.native = true;
    vi.useFakeTimers();
    let settled = false;

    const wait = waitForLaidOutBox(stubElement({ width: 0, height: 0 })).then(
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(LAYOUT_WAIT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // Bounded on purpose: a container that never measures must not hold the
    // lane open, or one wedged map stalls every create queued behind it.
    await vi.advanceTimersByTimeAsync(LAYOUT_WAIT_INTERVAL_MS * 2);
    await wait;
    expect(settled).toBe(true);
  });
});

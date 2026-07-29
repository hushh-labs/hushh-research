import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeSafeTracking,
  TRACKING_DIAGNOSTIC_CONSOLE_MESSAGE,
} from "../../lib/motion/api-progress-tracker";

describe("executeSafeTracking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true after a successful tracking payload executes", async () => {
    const trackingBlock = vi.fn();

    const result = await executeSafeTracking(trackingBlock);

    expect(result).toBe(true);
    expect(trackingBlock).toHaveBeenCalledTimes(1);
  });

  it("returns false and logs diagnostics when the tracker crashes on the network path", async () => {
    const networkError = new Error("network timeout while sending tracker payload");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await executeSafeTracking(async () => {
      throw networkError;
    });

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      TRACKING_DIAGNOSTIC_CONSOLE_MESSAGE,
      networkError,
    );
  });

  it("returns false for undefined or null payload exceptions without rethrowing", async () => {
    const nullPayload: { eventName: string } | null = null;
    const undefinedPayload: { eventName: string } | undefined = undefined;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const nullResult = await executeSafeTracking(() => {
      if (nullPayload === null) {
        throw new TypeError("tracking payload is null");
      }
    });
    const undefinedResult = await executeSafeTracking(() => {
      if (undefinedPayload === undefined) {
        throw new TypeError("tracking payload is undefined");
      }
    });

    expect(nullResult).toBe(false);
    expect(undefinedResult).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the application state alive regardless of tracking failure state", async () => {
    const appState = {
      alive: true,
      renderCount: 1,
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const failedResult = await executeSafeTracking(() => {
      throw new Error("tracker pipeline crashed");
    });
    appState.renderCount += 1;
    const successfulResult = await executeSafeTracking(() => undefined);

    expect(failedResult).toBe(false);
    expect(successfulResult).toBe(true);
    expect(appState).toEqual({
      alive: true,
      renderCount: 2,
    });
  });
});

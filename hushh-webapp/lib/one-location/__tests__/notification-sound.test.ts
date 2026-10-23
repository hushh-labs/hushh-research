import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installOneLocationNotificationSound,
  playOneLocationNotificationSound,
  stopOneLocationNotificationSound,
} from "../notification-sound";

describe("foreground SMS alarm lifetime", () => {
  const oscillators: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const vibrate = vi.fn().mockReturnValue(true);
  let release: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    oscillators.length = 0;
    vibrate.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.stubGlobal("AudioContext", class {
      state = "running";
      currentTime = 0;
      destination = {};
      close = vi.fn().mockResolvedValue(undefined);
      createOscillator() {
        const tone = { frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
        oscillators.push(tone);
        return tone;
      }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      }
    });
    vi.stubGlobal("navigator", { vibrate });
    release = installOneLocationNotificationSound();
  });

  afterEach(() => {
    release();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("repeats beyond the former one-second cue, then cancels every future sound and vibration", () => {
    expect(playOneLocationNotificationSound("sos", "grant-a")).toBe(true);
    // Duplicate delivery cannot create a second loop.
    playOneLocationNotificationSound("sos", "grant-a");
    vi.advanceTimersByTime(4500);
    expect(oscillators).toHaveLength(4);
    expect(vibrate).toHaveBeenCalledTimes(4);
    stopOneLocationNotificationSound("unrelated-grant");
    vi.advanceTimersByTime(1500);
    expect(oscillators).toHaveLength(5);
    stopOneLocationNotificationSound("grant-a");
    expect(vibrate).toHaveBeenLastCalledWith(0);
    const stoppedCount = vibrate.mock.calls.length;
    vi.advanceTimersByTime(60000);
    expect(oscillators).toHaveLength(5);
    expect(vibrate).toHaveBeenCalledTimes(stoppedCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["hidden", "pagehide", "dispose", "expired"])("releases repeating cues on %s", (cause) => {
    playOneLocationNotificationSound("sos", "grant-a", Date.now() + 1600);
    if (cause === "hidden") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    } else if (cause === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else if (cause === "dispose") release();
    vi.advanceTimersByTime(10000);
    const count = oscillators.length;
    vi.advanceTimersByTime(10000);
    expect(oscillators).toHaveLength(count);
    expect(vibrate).toHaveBeenLastCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ordinary cues one-shot and never queues blocked or stale alarms", () => {
    playOneLocationNotificationSound("share", "routine");
    vi.advanceTimersByTime(10000);
    expect(oscillators).toHaveLength(1);
    expect(vibrate).not.toHaveBeenCalled();
    expect(playOneLocationNotificationSound("sos", "expired", Date.now() - 1)).toBe(false);
    vi.stubGlobal("AudioContext", undefined);
    release();
    expect(playOneLocationNotificationSound("sos", "blocked")).toBe(false);
    vi.advanceTimersByTime(10000);
    expect(oscillators).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

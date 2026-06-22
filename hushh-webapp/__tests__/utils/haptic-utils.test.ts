import { afterEach, describe, expect, it, vi } from "vitest";

import { triggerToggleHaptic } from "@/lib/utils/haptic-utils";

const originalVibrateDescriptor = Object.getOwnPropertyDescriptor(
  Navigator.prototype,
  "vibrate"
);

function setNavigatorVibrate(value: unknown): void {
  Object.defineProperty(Navigator.prototype, "vibrate", {
    configurable: true,
    value,
  });
}

describe("haptic utils", () => {
  afterEach(() => {
    vi.restoreAllMocks();

    if (originalVibrateDescriptor) {
      Object.defineProperty(
        Navigator.prototype,
        "vibrate",
        originalVibrateDescriptor
      );
    } else {
      delete (Navigator.prototype as Partial<Navigator>).vibrate;
    }
  });

  // Vibration support is exercised through triggerToggleHaptic's observable
  // behavior (the support check is a module-internal guard, not a public export).
  it("returns false without logging when vibration is unsupported", () => {
    delete (Navigator.prototype as Partial<Navigator>).vibrate;
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    expect(triggerToggleHaptic()).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("triggers the browser vibration API with the default toggle pattern", () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setNavigatorVibrate(vibrate);

    expect(triggerToggleHaptic()).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it("sanitizes malformed vibration patterns before calling the browser API", () => {
    const vibrate = vi.fn().mockReturnValue(true);
    setNavigatorVibrate(vibrate);

    expect(triggerToggleHaptic([12, -1, Number.NaN, 4])).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([12, 4]);
  });

  it("fails silently when the browser blocks vibration", () => {
    const vibrate = vi.fn(() => {
      throw new Error("vibration blocked");
    });
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    setNavigatorVibrate(vibrate);

    expect(triggerToggleHaptic()).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

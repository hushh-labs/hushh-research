// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  theme: "light" as "light" | "dark",
  create: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: harness.theme }),
}));

vi.mock("@capacitor/google-maps", () => ({
  GoogleMap: { create: harness.create },
}));

vi.mock("@/lib/capacitor/platform", () => ({
  getPlatform: () => "ios",
  isNative: () => true,
}));

vi.mock("@/lib/one-location/maps-config", () => ({
  getNativeMapsApiKey: () => "native-test-key",
  getBrowserMapsApiKey: () => "browser-test-key",
  // Required: the dark branch reads this while building the create config, and
  // vitest throws on an export the mock does not define -- which fails the
  // create before it ever reaches the bridge, looking exactly like the bug.
  DARK_MAP_STYLES: [],
}));

vi.mock("@/lib/one-location/use-google-maps", () => ({
  useGoogleMaps: () => ({ status: "ready" }),
}));

// Real lock and claim semantics -- that is what these cases are about. Only the
// layout wait is stubbed: it polls a real timer on native, and jsdom has no
// layout to wait for. Its own budget is covered in
// __tests__/lib/one-location/native-map-lifecycle.test.ts.
vi.mock("@/lib/one-location/native-map-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/one-location/native-map-lifecycle")
  >()),
  waitForLaidOutBox: async () => undefined,
}));

import { LocationPickerMap } from "@/components/one-location/onboarding/location-picker-map";
import { __resetNativeMapLifecycleForTests } from "@/lib/one-location/native-map-lifecycle";

const PICKER_ID = "one-location-onboarding-picker-map";

const PICKER_PROPS = {
  initialLatitude: 28.6139,
  initialLongitude: 77.209,
  onConfirm: () => undefined,
  onCancel: () => undefined,
};

/**
 * The onboarding picker draws with the SAME @capacitor/google-maps renderer as
 * Your Map, under its own id, and had the same defect: `destroy()` addresses a
 * native map by string id with no instance identity, and `create()` cannot be
 * cancelled.
 *
 * Its trigger is more reliable than Your Map's. The create effect depends on
 * `colorScheme`, derived from next-themes' `resolvedTheme`, which is undefined
 * on first render and resolves after hydration -- inside the create window. So
 * an ordinary cold open re-ran the effect, the cleanup found no handle yet and
 * destroyed nothing, and the abandoned create then destroyed the id the second
 * run had just claimed. The picker reported itself ready over a blank canvas.
 */
describe("LocationPickerMap native lifecycle", () => {
  type Pending = {
    instance: number;
    map: Record<string, ReturnType<typeof vi.fn>>;
    land: () => void;
    settle: () => void;
    settled: boolean;
  };

  let registry: Map<string, number>;
  let pending: Pending[];

  function stubBridge() {
    registry = new Map();
    pending = [];
    let instances = 0;

    harness.create.mockImplementation((options: { id: string }) => {
      const instance = ++instances;
      const map = {
        destroy: vi.fn(async () => {
          await Promise.resolve();
          await Promise.resolve();
          // Keyed by id, never by identity -- the native contract.
          registry.delete(options.id);
        }),
        setOnCameraMoveStartedListener: vi.fn(async () => undefined),
        setOnCameraIdleListener: vi.fn(async () => undefined),
        setCamera: vi.fn(async () => undefined),
        disableTouch: vi.fn(async () => undefined),
        enableTouch: vi.fn(async () => undefined),
      };
      const entry: Pending = {
        instance,
        map,
        settled: false,
        land: () => registry.set(options.id, instance),
        settle: () => undefined,
      };
      pending.push(entry);
      return new Promise((resolve) => {
        entry.settle = () => {
          entry.settled = true;
          resolve(map);
        };
      });
    });
  }

  /**
   * Advance the bridge until it goes quiet. Within a round every outstanding
   * native call lands before any JS promise settles -- the real interleaving,
   * since the plugin's create timers fire close together while a destroy only
   * reaches native after `destroy()` has awaited its listener teardown.
   *
   * "Quiet" means two rounds with nothing outstanding, not one: a task freed by
   * the lane needs a few microtasks before it issues its own create, and
   * stopping at the first idle round would miss it entirely.
   */
  async function pump() {
    let quiet = 0;
    for (let round = 0; round < 12 && quiet < 2; round += 1) {
      await act(async () => {
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
      const outstanding = pending.filter((entry) => !entry.settled);
      if (outstanding.length === 0) {
        quiet += 1;
        continue;
      }
      quiet = 0;
      await act(async () => {
        for (const entry of outstanding) entry.land();
        for (const entry of outstanding) entry.settle();
        for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      });
    }
  }

  beforeEach(() => {
    __resetNativeMapLifecycleForTests();
    harness.theme = "light";
    harness.create.mockReset();
    stubBridge();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a live picker map when the theme resolves mid-create", async () => {
    const view = render(<LocationPickerMap {...PICKER_PROPS} />);
    await waitFor(() => expect(harness.create).toHaveBeenCalledTimes(1));

    // next-themes settles inside the create window, re-running the effect.
    harness.theme = "dark";
    view.rerender(<LocationPickerMap {...PICKER_PROPS} />);

    // Both phases, in the order the device produces them: every outstanding
    // native call lands, and only then do the JS promises settle. Settling one
    // create fully before the next is even issued hides this class of bug.
    await pump();

    // A picker that reports ready must have a native map registered under its
    // id -- and it must be the one the surviving mount created.
    expect(registry.has(PICKER_ID)).toBe(true);
    const live = registry.get(PICKER_ID);
    const owner = pending.find((entry) => entry.instance === live);
    expect(owner?.map.destroy).not.toHaveBeenCalled();
  });

  it("does not contend with Your Map's lane", async () => {
    // Separate ids get separate lanes: onboarding must never be able to stall
    // Your Map, or vice versa.
    const { withNativeMapLock } = await import(
      "@/lib/one-location/native-map-lifecycle"
    );
    let pickerHeld: (() => void) | null = null;
    void withNativeMapLock(
      PICKER_ID,
      () => new Promise<void>((resolve) => (pickerHeld = resolve)),
    );

    const ran = await withNativeMapLock(
      "one-location-private-map",
      async () => "your-map",
    );
    expect(ran).toBe("your-map");
    (pickerHeld as unknown as () => void)?.();
  });

  it("tears the picker map down when it unmounts", async () => {
    const view = render(
      <LocationPickerMap {...PICKER_PROPS} />,
    );
    await pump();
    expect(registry.has(PICKER_ID)).toBe(true);

    view.unmount();
    await act(async () => {
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    });

    // Leaving onboarding must free the id, or the next surface to claim it
    // races a native view that is still alive underneath the WebView.
    expect(registry.has(PICKER_ID)).toBe(false);
  });
});

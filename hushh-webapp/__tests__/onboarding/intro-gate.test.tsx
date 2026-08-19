import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  user: null as { uid: string; displayName?: string } | null,
  loading: true,
  isNative: false,
  localStore: new Map<string, string>(),
  nativeStore: new Map<string, string>(),
  reducedMotion: false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => harness.isNative },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: harness.nativeStore.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      harness.nativeStore.set(key, value);
    },
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: harness.user, loading: harness.loading }),
}));

import { HushhIntroGate } from "@/components/app-ui/HushhIntroGate";

const KEY = "hushh.one.intro.lastUid.v1";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HushhIntroGate", () => {
  beforeEach(() => {
    harness.user = null;
    harness.loading = true;
    harness.isNative = false;
    harness.localStore.clear();
    harness.nativeStore.clear();
    harness.reducedMotion = false;

    vi.stubGlobal("localStorage", {
      getItem: (key: string) => harness.localStore.get(key) ?? null,
      setItem: (key: string, value: string) => harness.localStore.set(key, value),
      removeItem: (key: string) => harness.localStore.delete(key),
    });
    vi.stubGlobal("matchMedia", () => ({
      matches: harness.reducedMotion,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mounts the app underneath instead of withholding it while the greeting plays", async () => {
    // It used to keep every /one guard out of the tree for the full three
    // seconds, so all of them resolved in the one frame after the fade — which
    // is when the lock and phone screens landed on top of each other.
    harness.loading = false;
    harness.user = { uid: "u1", displayName: "Ankit" };

    render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();

    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.getByText("Hi, Ankit")).toBeTruthy();
  });

  it("waits for the session before deciding, instead of skipping on a null account", async () => {
    // Reading the account while Firebase was still restoring returned null, and
    // null means "skip" — so whether anybody saw the greeting came down to
    // restore timing.
    harness.loading = true;
    harness.user = null;

    const view = render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();
    expect(harness.localStore.get(KEY)).toBeUndefined();

    await act(async () => {
      harness.loading = false;
      harness.user = { uid: "u1" };
      view.rerender(
        <HushhIntroGate>
          <p>the app</p>
        </HushhIntroGate>,
      );
    });
    await settle();

    expect(harness.localStore.get(KEY)).toBe("u1");
  });

  it("plays once per account and not again", async () => {
    harness.loading = false;
    harness.user = { uid: "u1" };
    harness.localStore.set(KEY, "u1");

    render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();

    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.queryByText(/Welcome to/)).toBeNull();
  });

  it("still greets a different account on the same device", async () => {
    harness.loading = false;
    harness.user = { uid: "u2" };
    harness.localStore.set(KEY, "u1");

    render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();

    expect(screen.getByText("Hi there")).toBeTruthy();
  });

  it("does not replay on a native cold start that emptied local storage", async () => {
    // WKWebView drops localStorage between launches under the custom scheme, so
    // without the durable mirror the greeting played on every single launch.
    harness.isNative = true;
    harness.loading = false;
    harness.user = { uid: "u1" };
    harness.nativeStore.set(KEY, "u1");

    render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();

    expect(screen.queryByText(/Welcome to/)).toBeNull();
    // And the synchronous copy is warm again for the rest of the launch.
    expect(harness.localStore.get(KEY)).toBe("u1");
  });

  it("writes the durable mirror the first time it plays on native", async () => {
    harness.isNative = true;
    harness.loading = false;
    harness.user = { uid: "u3" };

    render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();

    expect(harness.nativeStore.get(KEY)).toBe("u3");
  });

  it("shows nothing at all when motion is turned down", async () => {
    harness.reducedMotion = true;
    harness.loading = false;
    harness.user = { uid: "u1" };

    render(
      <HushhIntroGate>
        <p>the app</p>
      </HushhIntroGate>,
    );
    await settle();

    expect(screen.getByText("the app")).toBeTruthy();
    expect(screen.queryByText(/Welcome to/)).toBeNull();
  });
});

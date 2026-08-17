import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HushhIntroGate } from "@/components/app-ui/HushhIntroGate";

/**
 * #5394 — "App splash screen load time is sluggish".
 *
 * This component had NO tests, and the thing that made launch slow was a
 * structural property rather than a number: it was a GATE. `{children}` were
 * withheld from the React tree until a 4,770 ms animation finished, so the
 * vault-presence check and every first-screen fetch below it did not start
 * until the animation was over. Boot cost was ADDED to animation cost.
 *
 * The first test here is therefore the load-bearing one: children must be in
 * the document WHILE the overlay is still up. The duration test guards the
 * second half — that the hold itself fits the industry launch benchmark.
 */

const LAST_UID_KEY = "hushh.one.intro.lastUid.v1";
const authState: { user: { uid: string; displayName: string | null; email: string | null } | null } =
  { user: null };

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authState,
}));

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  authState.user = { uid: "user-1", displayName: "Ankit Singh", email: null };
  setReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HushhIntroGate (#5394)", () => {
  it("mounts the app underneath instead of withholding it", () => {
    // THE fix. Everything the app needs to do on launch — restore auth, check
    // the vault, fetch the first screen — now runs during the animation
    // rather than after it, so the wait is whichever is slower, not the sum.
    vi.useFakeTimers();
    render(
      <HushhIntroGate>
        <p>home screen</p>
      </HushhIntroGate>,
    );

    expect(screen.getByTestId("hushh-intro-gate")).toBeTruthy();
    expect(screen.getByText("home screen")).toBeTruthy();
  });

  it("is gone within the 1s launch benchmark", () => {
    vi.useFakeTimers();
    render(
      <HushhIntroGate>
        <p>home screen</p>
      </HushhIntroGate>,
    );

    // One frame short of the budget it must still be playing, or the test
    // would pass against an intro that never rendered at all.
    act(() => {
      vi.advanceTimersByTime(980);
    });
    expect(screen.queryByTestId("hushh-intro-gate")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(screen.queryByTestId("hushh-intro-gate")).toBeNull();
    expect(screen.getByText("home screen")).toBeTruthy();
  });

  it("blocks taps while it is opaque and releases them on the way out", () => {
    // A live app is mounted underneath now, which was not true before. An
    // overlay that let taps through would hand a launching person a control
    // they cannot see.
    vi.useFakeTimers();
    render(
      <HushhIntroGate>
        <p>home screen</p>
      </HushhIntroGate>,
    );

    const overlay = screen.getByTestId("hushh-intro-gate");
    expect(overlay.getAttribute("data-phase")).not.toBe("exit");

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(
      screen.getByTestId("hushh-intro-gate").getAttribute("data-phase"),
    ).toBe("exit");
  });

  it("skips entirely under reduced motion", () => {
    setReducedMotion(true);
    render(
      <HushhIntroGate>
        <p>home screen</p>
      </HushhIntroGate>,
    );

    expect(screen.queryByTestId("hushh-intro-gate")).toBeNull();
    expect(screen.getByText("home screen")).toBeTruthy();
  });

  it("does not replay for a uid that has already seen it", () => {
    window.localStorage.setItem(LAST_UID_KEY, "user-1");
    render(
      <HushhIntroGate>
        <p>home screen</p>
      </HushhIntroGate>,
    );

    expect(screen.queryByTestId("hushh-intro-gate")).toBeNull();
  });

  it("never plays in front of a logged-out redirect", () => {
    authState.user = null;
    render(
      <HushhIntroGate>
        <p>login redirect</p>
      </HushhIntroGate>,
    );

    expect(screen.queryByTestId("hushh-intro-gate")).toBeNull();
    expect(screen.getByText("login redirect")).toBeTruthy();
  });

  it("greets the signed-in person by first name", () => {
    vi.useFakeTimers();
    render(
      <HushhIntroGate>
        <p>home screen</p>
      </HushhIntroGate>,
    );

    expect(screen.getByText("Hi, Ankit")).toBeTruthy();
  });
});

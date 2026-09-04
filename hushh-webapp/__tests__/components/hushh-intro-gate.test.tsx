import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HushhIntroGate,
  __resetHushhIntroGateForTests,
} from "@/components/app-ui/HushhIntroGate";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      displayName: "JHUMMA KUMARI",
      email: "jhumma1101@gmail.com",
    },
  }),
}));

describe("HushhIntroGate", () => {
  beforeEach(() => {
    __resetHushhIntroGateForTests();
    vi.useFakeTimers();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion") ? false : false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("shows only the signed-in greeting and keeps it readable before completing", () => {
    render(
      <HushhIntroGate>
        <main>Private app</main>
      </HushhIntroGate>,
    );

    const intro = screen.getByTestId("hushh-intro-gate");
    expect(intro.getAttribute("data-phase")).toBe("idle");
    expect(screen.getByText("Hi, JHUMMA")).toBeTruthy();
    expect(screen.getByText("Welcome to")).toBeTruthy();
    expect(screen.queryByText("Hussh")).toBeNull();
    expect(screen.queryByText("Private app")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(intro.getAttribute("data-phase")).toBe("greet");

    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(intro.getAttribute("data-phase")).toBe("exit");

    act(() => {
      vi.advanceTimersByTime(440);
    });
    expect(screen.getByText("Private app")).toBeTruthy();
    expect(screen.queryByTestId("hushh-intro-gate")).toBeNull();
  });

  it("does not replay on a second mount in the same tab session", () => {
    // The report: back out of RIA -- a route-segment crossing, never a page
    // reload -- replayed the full greeting, which reads as the back button
    // giving up and relaunching the app instead of retracing a step. RIA,
    // Connect, and Marketplace are all separate Next.js segments from /one,
    // so entering /one from any of them remounts this component exactly the
    // way leaving RIA does.
    const { unmount } = render(
      <HushhIntroGate>
        <main>Private app</main>
      </HushhIntroGate>,
    );
    act(() => {
      vi.advanceTimersByTime(2360);
    });
    expect(screen.getByText("Private app")).toBeTruthy();
    unmount();

    render(
      <HushhIntroGate>
        <main>Private app</main>
      </HushhIntroGate>,
    );

    // No overlay, no timers to advance -- children are there on the very
    // first render of the remount.
    expect(screen.queryByTestId("hushh-intro-gate")).toBeNull();
    expect(screen.getByText("Private app")).toBeTruthy();
  });
});

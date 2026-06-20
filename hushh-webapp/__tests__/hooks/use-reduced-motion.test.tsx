import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import { useReducedMotion } from "@/hooks/use-reduced-motion";

/**
 * Tests for the `useReducedMotion` accessibility hook.
 *
 * The hook reads `prefers-reduced-motion: reduce` via `window.matchMedia`,
 * so each test owns the mock for its scenario and restores it in afterEach.
 */

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  onchange: ((event: MediaQueryListEvent) => void) | null;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  dispatchEvent: ReturnType<typeof vi.fn>;
}

function createMockMediaQueryList(
  matches: boolean,
  opts: { legacyOnly?: boolean } = {}
): MockMediaQueryList {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mql: MockMediaQueryList = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn((event: string, listener: EventListener) => {
      if (event === "change") {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    removeEventListener: vi.fn((event: string, listener: EventListener) => {
      if (event === "change") {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn((event: MediaQueryListEvent) => {
      listeners.forEach((listener) => listener(event));
      return true;
    }),
  };

  // For the "legacy Safari < 14" path the hook should fall back to
  // addListener / removeListener. Remove the modern API so the runtime
  // check fails and the fallback is exercised.
  if (opts.legacyOnly) {
    (mql as unknown as { addEventListener?: unknown }).addEventListener = undefined;
    (mql as unknown as { removeEventListener?: unknown }).removeEventListener = undefined;
  }

  return mql;
}

let originalMatchMedia: typeof window.matchMedia | undefined;

beforeEach(() => {
  originalMatchMedia = window.matchMedia;
});

afterEach(() => {
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia;
  } else {
    delete (window as unknown as { matchMedia?: typeof window.matchMedia }).matchMedia;
  }
  vi.restoreAllMocks();
});

function Harness({ onValue }: { onValue: (value: boolean) => void }) {
  const reduced = useReducedMotion();
  onValue(reduced);
  return <div data-testid="value">{reduced ? "reduced" : "full-motion"}</div>;
}

describe("useReducedMotion", () => {
  it("returns false when the media query does not match", () => {
    const mql = createMockMediaQueryList(false);
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const onValue = vi.fn();
    const { getByTestId } = render(<Harness onValue={onValue} />);

    expect(getByTestId("value").textContent).toBe("full-motion");
    expect(onValue).toHaveBeenLastCalledWith(false);
  });

  it("returns true when the media query already matches on mount", () => {
    const mql = createMockMediaQueryList(true);
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const onValue = vi.fn();
    const { getByTestId } = render(<Harness onValue={onValue} />);

    expect(getByTestId("value").textContent).toBe("reduced");
    expect(onValue).toHaveBeenLastCalledWith(true);
  });

  it("subscribes with the canonical `(prefers-reduced-motion: reduce)` query", () => {
    const mql = createMockMediaQueryList(false);
    const matchMediaSpy = vi.fn().mockReturnValue(mql);
    window.matchMedia = matchMediaSpy as unknown as typeof window.matchMedia;

    render(<Harness onValue={vi.fn()} />);

    expect(matchMediaSpy).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
  });

  it("updates when the user toggles reduced-motion at runtime", () => {
    const mql = createMockMediaQueryList(false);
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const onValue = vi.fn();
    const { getByTestId } = render(<Harness onValue={onValue} />);
    expect(getByTestId("value").textContent).toBe("full-motion");

    act(() => {
      mql.dispatchEvent({ matches: true, media: mql.media } as MediaQueryListEvent);
    });

    expect(getByTestId("value").textContent).toBe("reduced");
    expect(onValue).toHaveBeenLastCalledWith(true);

    act(() => {
      mql.dispatchEvent({ matches: false, media: mql.media } as MediaQueryListEvent);
    });

    expect(getByTestId("value").textContent).toBe("full-motion");
    expect(onValue).toHaveBeenLastCalledWith(false);
  });

  it("unsubscribes the listener on unmount (modern addEventListener path)", () => {
    const mql = createMockMediaQueryList(false);
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const { unmount } = render(<Harness onValue={vi.fn()} />);
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
    expect(mql.removeEventListener).not.toHaveBeenCalled();

    unmount();

    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("falls back to addListener / removeListener for legacy Safari (< 14)", () => {
    const mql = createMockMediaQueryList(true, { legacyOnly: true });
    window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;

    const onValue = vi.fn();
    const { unmount, getByTestId } = render(<Harness onValue={onValue} />);

    // Initial match is honoured even on the legacy path.
    expect(getByTestId("value").textContent).toBe("reduced");
    expect(mql.addListener).toHaveBeenCalledTimes(1);

    unmount();
    expect(mql.removeListener).toHaveBeenCalledTimes(1);
  });

  it("returns false when matchMedia is unavailable (SSR-like environment)", () => {
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;

    const onValue = vi.fn();
    const { getByTestId } = render(<Harness onValue={onValue} />);

    expect(getByTestId("value").textContent).toBe("full-motion");
    expect(onValue).toHaveBeenLastCalledWith(false);
  });
});
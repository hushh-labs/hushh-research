import * as React from "react";
import { render, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { useMediaQuery } from "@/lib/morphy-ux/use-media-query";

function Harness({
  query,
  onValue,
}: {
  query: string;
  onValue: (value: boolean) => void;
}) {
  const matches = useMediaQuery(query);

  React.useEffect(() => {
    onValue(matches);
  }, [matches, onValue]);

  return null;
}

describe("useMediaQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for a non-matching query", () => {
    const callback = vi.fn();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<Harness query="(min-width: 1200px)" onValue={callback} />);

    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 1200px)");
    expect(callback).toHaveBeenLastCalledWith(false);
  });

  it("returns true for a matching query", () => {
    const callback = vi.fn();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<Harness query="(max-width: 600px)" onValue={callback} />);

    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 600px)");
    expect(callback).toHaveBeenLastCalledWith(true);
  });

  it("updates value when a media query change event occurs", () => {
    const callback = vi.fn();
    let changeHandler: ((event: any) => void) | null = null;

    const addEventListener = vi.fn().mockImplementation((event: string, handler: any) => {
      if (event === "change") {
        changeHandler = handler;
      }
    });

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener,
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<Harness query="(min-width: 768px)" onValue={callback} />);
    expect(callback).toHaveBeenLastCalledWith(false);
    expect(changeHandler).toBeTypeOf("function");

    act(() => {
      if (changeHandler) {
        changeHandler({ matches: true } as MediaQueryListEvent);
      }
    });

    expect(callback).toHaveBeenLastCalledWith(true);
  });

  it("cleans up event listener on unmount", () => {
    const callback = vi.fn();
    const removeEventListener = vi.fn();

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { unmount } = render(<Harness query="(min-width: 768px)" onValue={callback} />);
    unmount();

    expect(removeEventListener).toHaveBeenCalled();
  });
});

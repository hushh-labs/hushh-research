import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import { useIsMobile } from "@/hooks/use-mobile";

function Harness({
  onValue,
}: {
  onValue: (value: boolean) => void;
}) {
  const isMobile = useIsMobile();

  React.useEffect(() => {
    onValue(isMobile);
  }, [isMobile, onValue]);

  return null;
}

describe("useIsMobile", () => {
  it("returns true when viewport is mobile sized", () => {
    const callback = vi.fn();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });

    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(<Harness onValue={callback} />);

    expect(callback).toHaveBeenLastCalledWith(true);
  });

  it("returns false when viewport is desktop sized", () => {
    const callback = vi.fn();

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1200,
    });

    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    render(<Harness onValue={callback} />);

    expect(callback).toHaveBeenLastCalledWith(false);
  });

  it("updates when viewport size changes", () => {
    const callback = vi.fn();

    let changeHandler: (() => void) | undefined;

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1200,
    });

    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: (_event: string, handler: () => void) => {
        changeHandler = handler;
      },
      removeEventListener: vi.fn(),
    }));

    render(<Harness onValue={callback} />);

    callback.mockClear();

    window.innerWidth = 500;

    act(() => {
      changeHandler?.();
    });

    expect(callback).toHaveBeenLastCalledWith(true);
  });
});
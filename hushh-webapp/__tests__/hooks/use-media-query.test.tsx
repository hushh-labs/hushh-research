import * as React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});
